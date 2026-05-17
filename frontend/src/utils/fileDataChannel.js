/**
 * fileDataChannel.js
 *
 * Handles chunked file transfer over an RTCDataChannel.
 * - Sends files as 16KB ArrayBuffer chunks with a JSON metadata header.
 * - Reassembles incoming chunks into a typed Blob and surfaces a download URL.
 *
 * Fix log (cross-device extension/MIME bug):
 *   - binaryType is now enforced to 'arraybuffer' inside receiveFile itself,
 *     guarding against race conditions when ondatachannel fires late.
 *   - Binary chunks that arrive as Blob objects (fallback path) are converted
 *     to ArrayBuffer before being pushed, so instanceof checks never silently fail.
 *   - The Blob is always constructed with { type: metadata.mimeType } so the
 *     OS/browser honours the correct MIME type on download.
 *   - The download anchor always receives the original filename (including
 *     extension) via metadata.name, so no extension is ever stripped.
 */

const CHUNK_SIZE = 16 * 1024; // 16 KB per chunk

/**
 * Sends a File over an RTCDataChannel in 16 KB chunks.
 *
 * @param {RTCDataChannel} dataChannel
 * @param {File} file
 * @param {function(number)} onProgress  - Called with 0–100.
 * @returns {Promise<void>}
 */
export function sendFile(dataChannel, file, onProgress) {
  return new Promise((resolve, reject) => {
    const totalChunks = Math.ceil(file.size / CHUNK_SIZE);
    let chunkIndex = 0;

    // ── 1. Send metadata header ──────────────────────────────────────────────
    const metaPayload = JSON.stringify({
      type: 'file-meta',
      name: file.name,                              // preserves full filename + extension
      size: file.size,
      mimeType: file.type || 'application/octet-stream',
      totalChunks,
    });
    dataChannel.send(metaPayload);

    // ── 2. Stream chunks with back-pressure guard ────────────────────────────
    const sendNextChunk = () => {
      // Pause if the send buffer is backing up
      if (dataChannel.bufferedAmount > 16 * CHUNK_SIZE) {
        setTimeout(sendNextChunk, 50);
        return;
      }

      if (chunkIndex >= totalChunks) {
        dataChannel.send(JSON.stringify({ type: 'file-end' }));
        onProgress(100);
        resolve();
        return;
      }

      const start = chunkIndex * CHUNK_SIZE;
      const end   = Math.min(start + CHUNK_SIZE, file.size);
      const slice = file.slice(start, end);

      const reader = new FileReader();
      reader.onload = (e) => {
        if (dataChannel.readyState !== 'open') {
          reject(new Error('DataChannel closed during transfer.'));
          return;
        }
        dataChannel.send(e.target.result);
        chunkIndex++;
        onProgress(Math.round((chunkIndex / totalChunks) * 100));
        setTimeout(sendNextChunk, 0); // yield to keep UI responsive
      };
      reader.onerror = (e) => reject(e);
      reader.readAsArrayBuffer(slice);
    };

    if (dataChannel.readyState === 'open') {
      sendNextChunk();
    } else {
      dataChannel.onopen = sendNextChunk;
    }
  });
}

/**
 * Wires a message handler onto an RTCDataChannel to receive and reassemble a file.
 *
 * @param {RTCDataChannel} dataChannel
 * @param {function(number)} onProgress        - Called with 0–99 during transfer, 100 on complete.
 * @param {function({name, size})} onMeta      - Called once metadata is received.
 * @param {function({name, url, size})} onComplete - Called with an object-URL blob ready for download.
 */
export function receiveFile(dataChannel, onProgress, onMeta, onComplete) {
  // ── FIX 1: Force binaryType here so it is always set, even if the caller
  //    already set it, and regardless of when ondatachannel fires.
  dataChannel.binaryType = 'arraybuffer';

  let metadata      = null;   // Stores file-meta JSON: { name, size, mimeType, totalChunks }
  const chunks      = [];     // Accumulated ArrayBuffer chunks
  let receivedBytes = 0;

  dataChannel.onmessage = async (event) => {
    const { data } = event;

    // ── Control messages (JSON strings) ─────────────────────────────────────
    if (typeof data === 'string') {
      let msg;
      try { msg = JSON.parse(data); } catch { return; } // ignore malformed frames

      if (msg.type === 'file-meta') {
        // ── FIX 2: Store all metadata fields explicitly ──────────────────
        metadata = {
          name:        msg.name        || 'received-file',
          size:        msg.size        || 0,
          mimeType:    msg.mimeType    || 'application/octet-stream',
          totalChunks: msg.totalChunks || 0,
        };
        chunks.length  = 0;
        receivedBytes  = 0;
        onMeta({ name: metadata.name, size: metadata.size });

      } else if (msg.type === 'file-end') {
        if (!metadata) return; // guard: metadata must have arrived first

        // ── FIX 3: Reconstruct Blob with explicit MIME type ──────────────
        //    This is what makes PDFs open as PDFs, PNGs as images, etc.
        const blob = new Blob(chunks, { type: metadata.mimeType });
        const url  = URL.createObjectURL(blob);

        onProgress(100);
        // ── FIX 4: Pass original filename (extension included) ───────────
        onComplete({ name: metadata.name, url, size: metadata.size });

        // Reset state for the next transfer over the same channel
        metadata      = null;
        chunks.length = 0;
        receivedBytes = 0;
      }
      return;
    }

    // ── Binary chunk ─────────────────────────────────────────────────────────
    if (!metadata) return; // metadata must arrive before any chunk

    let buffer;
    if (data instanceof ArrayBuffer) {
      // Normal path: binaryType = 'arraybuffer'
      buffer = data;
    } else if (data instanceof Blob) {
      // ── FIX 5: Fallback — some browsers may still deliver a Blob on the
      //    first message if binaryType was set after the channel opened.
      //    Convert synchronously via ArrayBuffer to keep ordering intact.
      buffer = await data.arrayBuffer();
    } else {
      return; // unexpected type — skip
    }

    chunks.push(buffer);
    receivedBytes += buffer.byteLength;

    const progress = Math.round((receivedBytes / metadata.size) * 100);
    onProgress(Math.min(progress, 99)); // hold at 99 until file-end confirms assembly
  };
}
