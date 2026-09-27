# Third-Party Notices

Screen Recorder Pro includes the following third-party component:

## @shiguredo/rnnoise-wasm 2025.1.5

- Purpose: real-time microphone noise suppression / VAD through WebAssembly.
- Source: https://github.com/shiguredo/rnnoise-wasm
- License: Apache License 2.0
- Copyright: Takeru Ohta (Original Author) and Shiguredo Inc.
- License text: licenses/Apache-2.0.txt

The WebAssembly component is based on Xiph.Org RNNoise. The upstream RNNoise
project declares its source code under the BSD 3-Clause license:
https://github.com/xiph/rnnoise/blob/main/COPYING

The vendored runtime is stored at shared/vendor/rnnoise.js and retains its
upstream package name, version, author, source URL, and Apache-2.0 attribution.
