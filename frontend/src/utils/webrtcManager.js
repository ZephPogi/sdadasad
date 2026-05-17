/**
 * webrtcManager.js
 * 
 * Manages RTCPeerConnection lifecycle, signaling relay via Socket.io,
 * and RTCDataChannel creation for file transfers.
 */

import { receiveFile } from './fileDataChannel';

const ICE_SERVERS = {
  iceServers: [
    // STUN servers for NAT traversal (free, public)
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
  ],
};

/**
 * Creates a managed RTCPeerConnection and wires up all signaling events.
 *
 * @param {object} socket         - The Socket.io client instance.
 * @param {string} targetId       - The remote peer's socket ID.
 * @param {boolean} isInitiator   - Whether this side creates the offer.
 * @param {object} callbacks      - { onProgress, onMeta, onComplete, onConnectionChange }
 * @returns {{ pc: RTCPeerConnection, channel: RTCDataChannel | null }}
 */
export function createPeerConnection(socket, targetId, isInitiator, callbacks) {
  const { onProgress, onMeta, onComplete, onConnectionChange } = callbacks;

  const pc = new RTCPeerConnection(ICE_SERVERS);
  let dataChannel = null;

  // ── ICE candidate handling ─────────────────────────────────────────────────
  pc.onicecandidate = (event) => {
    if (event.candidate) {
      socket.emit('signal', {
        targetId,
        signalData: { type: 'ice-candidate', candidate: event.candidate },
      });
    }
  };

  pc.onconnectionstatechange = () => {
    console.log(`[WebRTC] Connection state: ${pc.connectionState}`);
    onConnectionChange?.(pc.connectionState);
  };

  pc.oniceconnectionstatechange = () => {
    console.log(`[WebRTC] ICE state: ${pc.iceConnectionState}`);
  };

  // ── Data channel setup ─────────────────────────────────────────────────────
  if (isInitiator) {
    // Initiator creates the channel
    dataChannel = pc.createDataChannel('file-transfer', {
      ordered: true, // Guarantee ordering for file integrity
    });
    setupDataChannel(dataChannel, onProgress, onMeta, onComplete);
  } else {
    // Receiver listens for the channel to be opened by the initiator
    pc.ondatachannel = (event) => {
      dataChannel = event.channel;
      setupDataChannel(dataChannel, onProgress, onMeta, onComplete);
    };
  }

  // ── Offer/Answer negotiation (initiator side) ──────────────────────────────
  if (isInitiator) {
    pc.createOffer()
      .then((offer) => pc.setLocalDescription(offer))
      .then(() => {
        socket.emit('signal', {
          targetId,
          signalData: pc.localDescription,
        });
      })
      .catch((err) => console.error('[WebRTC] Offer error:', err));
  }

  return { pc, getDataChannel: () => dataChannel };
}

/**
 * Processes an incoming signal (offer, answer, or ICE candidate).
 *
 * @param {RTCPeerConnection} pc
 * @param {object} socket
 * @param {string} senderId   - The remote peer's socket ID.
 * @param {object} signalData - The raw signal payload from the server.
 */
export async function handleIncomingSignal(pc, socket, senderId, signalData) {
  try {
    if (signalData.type === 'offer') {
      await pc.setRemoteDescription(new RTCSessionDescription(signalData));
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      socket.emit('signal', {
        targetId: senderId,
        signalData: pc.localDescription,
      });
    } else if (signalData.type === 'answer') {
      await pc.setRemoteDescription(new RTCSessionDescription(signalData));
    } else if (signalData.type === 'ice-candidate' && signalData.candidate) {
      await pc.addIceCandidate(new RTCIceCandidate(signalData.candidate));
    }
  } catch (err) {
    console.error('[WebRTC] Signal handling error:', err);
  }
}

// ── Internal helper ────────────────────────────────────────────────────────────
function setupDataChannel(channel, onProgress, onMeta, onComplete) {
  // NOTE: binaryType = 'arraybuffer' is set inside receiveFile() so it is
  // always applied immediately before the onmessage handler is registered,
  // regardless of when ondatachannel fires on the receiving side.

  channel.onopen = () => {
    console.log('[DataChannel] Open and ready.');
  };

  channel.onclose = () => {
    console.log('[DataChannel] Closed.');
  };

  channel.onerror = (err) => {
    console.error('[DataChannel] Error:', err);
  };

  // Wire the channel to our file receiver.
  // receiveFile sets binaryType and onmessage atomically.
  receiveFile(channel, onProgress, onMeta, onComplete);
}
