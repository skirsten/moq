[![Documentation](https://docs.rs/moq-lite/badge.svg)](https://docs.rs/moq-lite/)
[![Crates.io](https://img.shields.io/crates/v/moq-lite.svg)](https://crates.io/crates/moq-lite)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE-MIT)

# moq-lite

A Rust implementation of the [Media over QUIC](https://moq.dev) transport.

This crate provides the core networking layer, implementing the [moq-lite specification](https://datatracker.ietf.org/doc/draft-lcurley-moq-lite/).
Live media is built on top of this layer using something like [hang](../hang).

- **Broadcasts**: Discoverable collections of tracks.
- **Tracks**: Named streams of data, split into groups.
- **Groups**: A sequential collection of frames, usually starting with a keyframe.
- **Frame**: A timed chunk of data.

## Examples
- [Publishing a chat track](../moq-native/examples/chat.rs)
- [Publishing or consuming a clock track](../moq-clock)
