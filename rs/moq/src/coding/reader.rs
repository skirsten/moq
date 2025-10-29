use std::{cmp, io, sync::Arc};

use bytes::{Buf, Bytes, BytesMut};

use crate::{coding::*, Error};

pub struct Reader<S: web_transport_trait::RecvStream> {
	stream: S,
	buffer: BytesMut,
}

impl<S: web_transport_trait::RecvStream> Reader<S> {
	pub fn new(stream: S) -> Self {
		Self {
			stream,
			buffer: Default::default(),
		}
	}

	pub async fn decode<T: Decode>(&mut self) -> Result<T, Error> {
		loop {
			let mut cursor = io::Cursor::new(&self.buffer);
			match T::decode(&mut cursor) {
				Ok(msg) => {
					self.buffer.advance(cursor.position() as usize);
					return Ok(msg);
				}
				Err(DecodeError::Short) => {
					// Try to read more data
					if self
						.stream
						.read_buf(&mut self.buffer)
						.await
						.map_err(|e| Error::Transport(Arc::new(e)))?
						.is_none()
					{
						// Stream closed while we still need more data
						return Err(Error::Decode(DecodeError::Short));
					}
				}
				Err(e) => return Err(Error::Decode(e)),
			}
		}
	}

	// Decode optional messages at the end of a stream
	pub async fn decode_maybe<T: Decode>(&mut self) -> Result<Option<T>, Error> {
		match self.closed().await {
			Ok(()) => Ok(None),
			Err(Error::Decode(DecodeError::ExpectedEnd)) => Ok(Some(self.decode().await?)),
			Err(e) => Err(e),
		}
	}

	pub async fn decode_peek<T: Decode>(&mut self) -> Result<T, Error> {
		loop {
			let mut cursor = io::Cursor::new(&self.buffer);
			match T::decode(&mut cursor) {
				Ok(msg) => return Ok(msg),
				Err(DecodeError::Short) => {
					// Try to read more data
					if self
						.stream
						.read_buf(&mut self.buffer)
						.await
						.map_err(|e| Error::Transport(Arc::new(e)))?
						.is_none()
					{
						// Stream closed while we still need more data
						return Err(Error::Decode(DecodeError::Short));
					}
				}
				Err(e) => return Err(Error::Decode(e)),
			}
		}
	}

	// Returns a non-zero chunk of data, or None if the stream is closed
	pub async fn read(&mut self, max: usize) -> Result<Option<Bytes>, Error> {
		if !self.buffer.is_empty() {
			let size = cmp::min(max, self.buffer.len());
			let data = self.buffer.split_to(size).freeze();
			return Ok(Some(data));
		}

		self.stream
			.read_chunk(max)
			.await
			.map_err(|e| Error::Transport(Arc::new(e)))
	}

	pub async fn read_exact(&mut self, size: usize) -> Result<Bytes, Error> {
		// An optimization to avoid a copy if we have enough data in the buffer
		if self.buffer.len() >= size {
			return Ok(self.buffer.split_to(size).freeze());
		}

		let data = BytesMut::with_capacity(size.min(u16::MAX as usize));
		let mut buf = data.limit(size);

		let size = cmp::min(buf.remaining_mut(), self.buffer.len());
		let data = self.buffer.split_to(size);
		buf.put(data);

		while buf.has_remaining_mut() {
			self.stream
				.read_buf(&mut buf)
				.await
				.map_err(|e| Error::Transport(Arc::new(e)))?;
		}

		Ok(buf.into_inner().freeze())
	}

	pub async fn skip(&mut self, mut size: usize) -> Result<(), Error> {
		let buffered = self.buffer.len();
		self.buffer.advance(size.min(buffered));
		size -= buffered;

		while size > 0 {
			let chunk = self
				.stream
				.read_chunk(size)
				.await
				.map_err(|e| Error::Transport(Arc::new(e)))?
				.ok_or(Error::Decode(DecodeError::Short))?;
			size -= chunk.len();
		}

		Ok(())
	}

	/// Wait until the stream is closed, erroring if there are any additional bytes.
	pub async fn closed(&mut self) -> Result<(), Error> {
		if self.buffer.is_empty()
			&& self
				.stream
				.read_buf(&mut self.buffer)
				.await
				.map_err(|e| Error::Transport(Arc::new(e)))?
				.is_none()
		{
			return Ok(());
		}

		Err(DecodeError::ExpectedEnd.into())
	}

	pub fn abort(&mut self, err: &Error) {
		self.stream.stop(err.to_code());
	}
}
