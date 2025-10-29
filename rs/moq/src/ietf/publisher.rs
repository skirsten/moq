use std::{collections::HashMap, sync::Arc};

use tokio::sync::oneshot;
use web_async::{FuturesExt, Lock};
use web_transport_trait::SendStream;

use crate::{
	coding::Writer,
	ietf::{self, Control, FetchHeader, FetchType, FilterType, GroupOrder, Location},
	model::GroupConsumer,
	Error, Origin, OriginConsumer, Track, TrackConsumer,
};

#[derive(Clone)]
pub(super) struct Publisher<S: web_transport_trait::Session> {
	session: S,
	origin: OriginConsumer,
	control: Control,

	// Drop in order to cancel the subscribe.
	subscribes: Lock<HashMap<u64, oneshot::Sender<()>>>,
}

impl<S: web_transport_trait::Session> Publisher<S> {
	pub fn new(session: S, origin: Option<OriginConsumer>, control: Control) -> Self {
		// Default to a dummy origin that is immediately closed.
		let origin = origin.unwrap_or_else(|| Origin::produce().consumer);
		Self {
			session,
			origin,
			control,
			subscribes: Default::default(),
		}
	}

	pub async fn run(mut self) -> Result<(), Error> {
		while let Some((path, active)) = self.origin.announced().await {
			let suffix = path.to_owned();

			if active.is_some() {
				tracing::debug!(broadcast = %self.origin.absolute(&path), "announce");
				let request_id = self.control.request_id();

				self.control.send(ietf::PublishNamespace {
					request_id,
					track_namespace: suffix,
				})?;
			} else {
				tracing::debug!(broadcast = %self.origin.absolute(&path), "unannounce");
				self.control.send(ietf::PublishNamespaceDone {
					track_namespace: suffix,
				})?;
			}
		}

		Ok(())
	}

	pub fn recv_subscribe(&mut self, msg: ietf::Subscribe<'_>) -> Result<(), Error> {
		match msg.filter_type {
			FilterType::AbsoluteStart | FilterType::AbsoluteRange => {
				return self.control.send(ietf::SubscribeError {
					request_id: msg.request_id,
					error_code: 500,
					reason_phrase: "Absolute subscribe not supported".into(),
				});
			}
			// We actually send LargestGroup, which the peer can't enforce anyway.
			FilterType::NextGroup | FilterType::LargestObject => {}
		};

		let request_id = msg.request_id;

		let track = msg.track_name.clone();
		let absolute = self.origin.absolute(&msg.track_namespace).to_owned();

		tracing::info!(id = %request_id, broadcast = %absolute, %track, "subscribed started");

		let broadcast = match self.origin.consume_broadcast(&msg.track_namespace) {
			Some(consumer) => consumer,
			None => {
				self.control.send(ietf::SubscribeError {
					request_id,
					error_code: 404,
					reason_phrase: "Broadcast not found".into(),
				})?;
				return Ok(());
			}
		};

		let track = Track {
			name: msg.track_name.to_string(),
			priority: msg.subscriber_priority,
		};

		let track = broadcast.subscribe_track(&track);

		let (tx, rx) = oneshot::channel();
		let mut subscribes = self.subscribes.lock();
		subscribes.insert(request_id, tx);

		self.control.send(ietf::SubscribeOk {
			request_id,
			track_alias: request_id,
		})?;

		let session = self.session.clone();
		let control = self.control.clone();
		let request_id = msg.request_id;
		let subscribes = self.subscribes.clone();

		web_async::spawn(async move {
			if let Err(err) = Self::run_track(session, track, request_id, rx).await {
				control
					.send(ietf::SubscribeError {
						request_id,
						error_code: 500,
						reason_phrase: err.to_string().into(),
					})
					.ok();
			} else {
				control
					.send(ietf::PublishDone {
						request_id,
						status_code: 200,
						reason_phrase: "OK".into(),
					})
					.ok();
			}

			subscribes.lock().remove(&request_id);
		});

		Ok(())
	}

	pub fn recv_subscribe_update(&mut self, msg: ietf::SubscribeUpdate) -> Result<(), Error> {
		self.control.send(ietf::SubscribeError {
			request_id: msg.request_id,
			error_code: 500,
			reason_phrase: "subscribe update not supported".into(),
		})
	}

	async fn run_track(
		session: S,
		mut track: TrackConsumer,
		request_id: u64,
		mut cancel: oneshot::Receiver<()>,
	) -> Result<(), Error> {
		// TODO use a BTreeMap serve the latest N groups by sequence.
		// Until then, we'll implement N=2 manually.
		// Also, this is more complicated because we can't use tokio because of WASM.
		// We need to drop futures in order to cancel them and keep polling them with select!
		let mut old_group = None;
		let mut new_group = None;

		// Annoying that we can't use a tuple here as we need the compiler to infer the type.
		// Otherwise we'd have to pick Send or !Send...
		let mut old_sequence = None;
		let mut new_sequence = None;

		// Keep reading groups from the track, some of which may arrive out of order.
		loop {
			let group = tokio::select! {
				biased;
				_ = &mut cancel => return Ok(()),
				Some(group) = track.next_group().transpose() => group,
				Some(_) = async { Some(old_group.as_mut()?.await) } => {
					old_group = None;
					old_sequence = None;
					continue;
				},
				Some(_) = async { Some(new_group.as_mut()?.await) } => {
					new_group = old_group;
					new_sequence = old_sequence;
					old_group = None;
					old_sequence = None;
					continue;
				},
				else => return Ok(()),
			}?;

			let sequence = group.info.sequence;
			let latest = new_sequence.as_ref().unwrap_or(&0);

			tracing::debug!(subscribe = %request_id, track = %track.info.name, sequence, latest, "serving group");

			// If this group is older than the oldest group we're serving, skip it.
			// We always serve at most two groups, but maybe we should serve only sequence >= MAX-1.
			if sequence < *old_sequence.as_ref().unwrap_or(&0) {
				tracing::debug!(subscribe = %request_id, track = %track.info.name, old = %sequence, %latest, "skipping group");
				continue;
			}

			let priority = stream_priority(track.info.priority, sequence);
			let msg = ietf::GroupHeader {
				track_alias: request_id,
				group_id: sequence,
				flags: Default::default(),
			};

			// Spawn a task to serve this group, ignoring any errors because they don't really matter.
			// TODO add some logging at least.
			let handle = Box::pin(Self::run_group(session.clone(), msg, priority, group));

			// Terminate the old group if it's still running.
			if let Some(old_sequence) = old_sequence.take() {
				tracing::debug!(subscribe = %request_id, track = %track.info.name, old = %old_sequence, %latest, "aborting group");
				old_group.take(); // Drop the future to cancel it.
			}

			assert!(old_group.is_none());

			if sequence >= *latest {
				old_group = new_group;
				old_sequence = new_sequence;

				new_group = Some(handle);
				new_sequence = Some(sequence);
			} else {
				old_group = Some(handle);
				old_sequence = Some(sequence);
			}
		}
	}

	async fn run_group(
		session: S,
		msg: ietf::GroupHeader,
		priority: i32,
		mut group: GroupConsumer,
	) -> Result<(), Error> {
		// TODO add a way to open in priority order.
		let mut stream = session
			.open_uni()
			.await
			.map_err(|err| Error::Transport(Arc::new(err)))?;
		stream.set_priority(priority);

		let mut stream = Writer::new(stream);
		stream.encode(&msg).await?;

		loop {
			let frame = tokio::select! {
				biased;
				_ = stream.closed() => return Err(Error::Cancel),
				frame = group.next_frame() => frame,
			};

			let mut frame = match frame? {
				Some(frame) => frame,
				None => break,
			};

			tracing::trace!(size = %frame.info.size, "writing frame");

			// object id is always 0.
			stream.encode(&0u8).await?;

			// not using extensions.
			if msg.flags.has_extensions {
				stream.encode(&0u8).await?;
			}

			// Write the size of the frame.
			stream.encode(&frame.info.size).await?;

			if frame.info.size == 0 {
				// Have to write the object status too.
				stream.encode(&0u8).await?;
			} else {
				// Stream each chunk of the frame.
				loop {
					let chunk = tokio::select! {
						biased;
						_ = stream.closed() => return Err(Error::Cancel),
						chunk = frame.read_chunk() => chunk,
					};

					match chunk? {
						Some(mut chunk) => stream.write_all(&mut chunk).await?,
						None => break,
					}
				}
			}

			tracing::trace!(size = %frame.info.size, "wrote frame");
		}

		stream.finish().await?;

		tracing::debug!(sequence = %msg.group_id, "finished group");

		Ok(())
	}

	pub fn recv_unsubscribe(&mut self, msg: ietf::Unsubscribe) -> Result<(), Error> {
		let mut subscribes = self.subscribes.lock();
		if let Some(tx) = subscribes.remove(&msg.request_id) {
			let _ = tx.send(());
		}
		Ok(())
	}

	pub fn recv_publish_namespace_ok(&mut self, _msg: ietf::PublishNamespaceOk) -> Result<(), Error> {
		// We don't care.
		Ok(())
	}

	pub fn recv_subscribe_namespace(&mut self, _msg: ietf::SubscribeNamespace<'_>) -> Result<(), Error> {
		// We don't care, we're sending all announcements anyway.
		Ok(())
	}

	pub fn recv_publish_namespace_error(&mut self, msg: ietf::PublishNamespaceError<'_>) -> Result<(), Error> {
		tracing::warn!(?msg, "publish namespace error");
		Ok(())
	}

	pub fn recv_unsubscribe_namespace(&mut self, _msg: ietf::UnsubscribeNamespace) -> Result<(), Error> {
		// We don't care, we're sending all announcements anyway.
		Ok(())
	}

	pub fn recv_publish_namespace_cancel(&mut self, msg: ietf::PublishNamespaceCancel<'_>) -> Result<(), Error> {
		tracing::warn!(?msg, "publish namespace cancel");
		Ok(())
	}

	pub fn recv_track_status(&mut self, _msg: ietf::TrackStatus<'_>) -> Result<(), Error> {
		Err(Error::Unsupported)
	}

	pub fn recv_fetch(&mut self, msg: ietf::Fetch<'_>) -> Result<(), Error> {
		let subscribe_id = match msg.fetch_type {
			FetchType::Standalone { .. } => {
				return self.control.send(ietf::FetchError {
					request_id: msg.request_id,
					error_code: 500,
					reason_phrase: "not supported".into(),
				});
			}
			FetchType::RelativeJoining {
				subscriber_request_id,
				group_offset,
			} => {
				if group_offset != 0 {
					return self.control.send(ietf::FetchError {
						request_id: msg.request_id,
						error_code: 500,
						reason_phrase: "not supported".into(),
					});
				}

				subscriber_request_id
			}
			FetchType::AbsoluteJoining { .. } => {
				return self.control.send(ietf::FetchError {
					request_id: msg.request_id,
					error_code: 500,
					reason_phrase: "not supported".into(),
				});
			}
		};

		let subscribes = self.subscribes.lock();
		if !subscribes.contains_key(&subscribe_id) {
			return self.control.send(ietf::FetchError {
				request_id: msg.request_id,
				error_code: 404,
				reason_phrase: "Subscribe not found".into(),
			});
		}

		self.control.send(ietf::FetchOk {
			request_id: msg.request_id,
			group_order: GroupOrder::Descending,
			end_of_track: false,
			// TODO get the proper group_id
			end_location: Location { group: 0, object: 0 },
		})?;

		let session = self.session.clone();
		let request_id = msg.request_id;

		web_async::spawn(async move {
			if let Err(err) = Self::run_fetch(session, request_id).await {
				tracing::warn!(?err, "error running fetch");
			}
		});

		Ok(())
	}

	// We literally just create a stream and FIN it.
	async fn run_fetch(session: S, request_id: u64) -> Result<(), Error> {
		let stream = session
			.open_uni()
			.await
			.map_err(|err| Error::Transport(Arc::new(err)))?;

		let mut writer = Writer::new(stream);
		writer.encode(&FetchHeader::TYPE).await?;
		writer.encode(&FetchHeader { request_id }).await?;
		writer.finish().await?;

		Ok(())
	}

	pub fn recv_fetch_cancel(&mut self, msg: ietf::FetchCancel) -> Result<(), Error> {
		tracing::warn!(?msg, "fetch cancel");
		Ok(())
	}
}

// Quinn takes a i32 priority.
// We do our best to distill 70 bits of information into 32 bits, but overflows will happen.
// Specifically, group sequence 2^24 will overflow and be incorrectly prioritized.
// But even with a group per frame, it will take ~6 days to reach that point.
// TODO The behavior when two tracks share the same priority is undefined. Should we round-robin?
fn stream_priority(track_priority: u8, group_sequence: u64) -> i32 {
	let sequence = 0xFFFFFF - (group_sequence as u32 & 0xFFFFFF);
	((track_priority as i32) << 24) | sequence as i32
}
