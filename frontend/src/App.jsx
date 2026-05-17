import { useState, useEffect, useRef, useCallback } from 'react';
import { io } from 'socket.io-client';
import {
  Wifi, WifiOff, Users, Upload, FileText, CheckCircle,
  AlertCircle, Loader2, Download, X, Zap, HardDrive
} from 'lucide-react';
import { createPeerConnection, handleIncomingSignal } from './utils/webrtcManager';
import { sendFile } from './utils/fileDataChannel';
import './App.css';

const SIGNAL_SERVER = `http://${window.location.hostname}:3001`;

// Generate a friendly random name for this peer
const ADJECTIVES = ['Swift', 'Bright', 'Cyber', 'Neon', 'Orbit', 'Pulse', 'Sonic', 'Volt'];
const NOUNS = ['Falcon', 'Nova', 'Prism', 'Quasar', 'Relay', 'Stream', 'Titan', 'Vortex'];
const PEER_NAME = `${ADJECTIVES[Math.floor(Math.random() * ADJECTIVES.length)]}-${NOUNS[Math.floor(Math.random() * NOUNS.length)]}`;

function formatBytes(bytes) {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return `${parseFloat((bytes / Math.pow(k, i)).toFixed(1))} ${sizes[i]}`;
}

function formatTime(iso) {
  return new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

function getFileIcon(name) {
  const ext = name?.split('.').pop()?.toLowerCase();
  const images = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'svg'];
  const videos = ['mp4', 'mov', 'avi', 'mkv', 'webm'];
  const audio = ['mp3', 'wav', 'flac', 'ogg', 'm4a'];
  if (images.includes(ext)) return '🖼️';
  if (videos.includes(ext)) return '🎬';
  if (audio.includes(ext)) return '🎵';
  if (ext === 'pdf') return '📄';
  if (['zip', 'rar', '7z', 'tar'].includes(ext)) return '📦';
  if (['js', 'ts', 'jsx', 'tsx', 'py', 'go', 'rs'].includes(ext)) return '💻';
  return '📁';
}

export default function App() {
  const socketRef = useRef(null);
  const [connected, setConnected] = useState(false);
  const [myPeer, setMyPeer] = useState(null);
  const [peers, setPeers] = useState([]);
  const [selectedPeer, setSelectedPeer] = useState(null);
  const [dragOver, setDragOver] = useState(false);
  const [transfers, setTransfers] = useState([]); // { id, direction, fileName, fileSize, progress, status, url? }
  const [incomingFiles, setIncomingFiles] = useState([]);
  const fileInputRef = useRef(null);

  // Map of peerId -> { pc, getDataChannel }
  const connectionsRef = useRef({});

  // ── Socket.io setup ────────────────────────────────────────────────────────
  useEffect(() => {
    const socket = io(SIGNAL_SERVER, { reconnectionAttempts: 5 });
    socketRef.current = socket;

    socket.on('connect', () => {
      setConnected(true);
      socket.emit('register', { name: PEER_NAME });
    });

    socket.on('disconnect', () => {
      setConnected(false);
      connectionsRef.current = {};
    });

    socket.on('registered', (peer) => {
      setMyPeer(peer);
    });

    socket.on('peer-list', (list) => {
      // Exclude ourselves from the visible peer list
      setPeers(list.filter((p) => p.id !== socket.id));
    });

    // ── Incoming signal relay ──────────────────────────────────────────────
    socket.on('signal', ({ senderId, senderName, signalData }) => {
      // If we haven't set up a connection for this sender yet, we are the receiver
      if (!connectionsRef.current[senderId]) {
        const conn = createPeerConnection(
          socket,
          senderId,
          false, // we are NOT the initiator
          buildCallbacks(senderId, senderName)
        );
        connectionsRef.current[senderId] = conn;
      }

      handleIncomingSignal(
        connectionsRef.current[senderId].pc,
        socket,
        senderId,
        signalData
      );
    });

    return () => {
      socket.disconnect();
      // Close all peer connections on unmount
      Object.values(connectionsRef.current).forEach(({ pc }) => pc.close());
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Callbacks factory for incoming file events ─────────────────────────────
  const buildCallbacks = useCallback((peerId, peerName) => {
    const transferId = `recv-${peerId}-${Date.now()}`;
    let resolvedId = transferId;

    return {
      onConnectionChange: (state) => {
        console.log(`[App] Connection to ${peerName}: ${state}`);
      },
      onMeta: ({ name, size }) => {
        resolvedId = `recv-${peerId}-${Date.now()}`;
        setTransfers((prev) => [
          ...prev,
          {
            id: resolvedId,
            direction: 'receive',
            peerName,
            fileName: name,
            fileSize: size,
            progress: 0,
            status: 'receiving',
          },
        ]);
      },
      onProgress: (progress) => {
        setTransfers((prev) =>
          prev.map((t) =>
            t.id === resolvedId ? { ...t, progress } : t
          )
        );
      },
      onComplete: ({ name, url, size }) => {
        setTransfers((prev) =>
          prev.map((t) =>
            t.id === resolvedId
              ? { ...t, progress: 100, status: 'done', url }
              : t
          )
        );
        setIncomingFiles((prev) => [
          { id: resolvedId, name, size, url, from: peerName, receivedAt: new Date().toISOString() },
          ...prev,
        ]);
      },
    };
  }, []);

  // ── Initiate a WebRTC connection to a peer and send a file ────────────────
  const sendFileToPeer = useCallback(
    async (targetPeer, file) => {
      const socket = socketRef.current;
      if (!socket || !targetPeer) return;

      const transferId = `send-${targetPeer.id}-${Date.now()}`;

      setTransfers((prev) => [
        ...prev,
        {
          id: transferId,
          direction: 'send',
          peerName: targetPeer.name,
          fileName: file.name,
          fileSize: file.size,
          progress: 0,
          status: 'connecting',
        },
      ]);

      // Establish or reuse peer connection
      if (!connectionsRef.current[targetPeer.id]) {
        const conn = createPeerConnection(
          socket,
          targetPeer.id,
          true, // we ARE the initiator
          buildCallbacks(targetPeer.id, targetPeer.name)
        );
        connectionsRef.current[targetPeer.id] = conn;
      }

      const { pc, getDataChannel } = connectionsRef.current[targetPeer.id];

      // Wait for the data channel to be open (with a 10s timeout)
      await new Promise((resolve, reject) => {
        const channel = getDataChannel();
        if (channel?.readyState === 'open') {
          resolve();
          return;
        }
        const timeout = setTimeout(() => reject(new Error('Connection timed out')), 10000);
        const checkOpen = setInterval(() => {
          const ch = getDataChannel();
          if (ch?.readyState === 'open') {
            clearInterval(checkOpen);
            clearTimeout(timeout);
            resolve();
          } else if (pc.connectionState === 'failed' || pc.connectionState === 'closed') {
            clearInterval(checkOpen);
            clearTimeout(timeout);
            reject(new Error('Peer connection failed'));
          }
        }, 100);
      }).catch((err) => {
        setTransfers((prev) =>
          prev.map((t) =>
            t.id === transferId ? { ...t, status: 'error', error: err.message } : t
          )
        );
        throw err;
      });

      setTransfers((prev) =>
        prev.map((t) =>
          t.id === transferId ? { ...t, status: 'sending' } : t
        )
      );

      try {
        await sendFile(getDataChannel(), file, (progress) => {
          setTransfers((prev) =>
            prev.map((t) =>
              t.id === transferId ? { ...t, progress } : t
            )
          );
        });
        setTransfers((prev) =>
          prev.map((t) =>
            t.id === transferId ? { ...t, status: 'done', progress: 100 } : t
          )
        );
      } catch (err) {
        setTransfers((prev) =>
          prev.map((t) =>
            t.id === transferId ? { ...t, status: 'error', error: err.message } : t
          )
        );
      }
    },
    [buildCallbacks]
  );

  // ── Drag-and-drop handlers ─────────────────────────────────────────────────
  const handleDrop = useCallback(
    (e) => {
      e.preventDefault();
      setDragOver(false);
      const file = e.dataTransfer.files[0];
      if (!file || !selectedPeer) return;
      sendFileToPeer(selectedPeer, file);
    },
    [selectedPeer, sendFileToPeer]
  );

  const handleFileInput = useCallback(
    (e) => {
      const file = e.target.files[0];
      if (!file || !selectedPeer) return;
      sendFileToPeer(selectedPeer, file);
      e.target.value = '';
    },
    [selectedPeer, sendFileToPeer]
  );

  const dismissTransfer = (id) =>
    setTransfers((prev) => prev.filter((t) => t.id !== id));

  // ── Render ─────────────────────────────────────────────────────────────────
  return (
    <div className="app">
      {/* ── Header ── */}
      <header className="header">
        <div className="header-brand">
          <div className="brand-icon">
            <Zap size={20} />
          </div>
          <div>
            <h1 className="brand-name">Parallel</h1>
            <p className="brand-tagline">Local P2P File Transfer</p>
          </div>
        </div>

        <div className="header-status">
          <div className={`status-chip ${connected ? 'status-chip--online' : 'status-chip--offline'}`}>
            {connected ? <Wifi size={13} /> : <WifiOff size={13} />}
            <span>{connected ? 'Connected' : 'Offline'}</span>
          </div>
          {myPeer && (
            <div className="my-identity">
              <span className="identity-label">You are</span>
              <span className="identity-name">{myPeer.name}</span>
            </div>
          )}
        </div>
      </header>

      <main className="main">
        {/* ── Left panel: Peers ── */}
        <section className="panel panel--peers">
          <div className="panel-header">
            <Users size={16} />
            <h2>Network Peers</h2>
            <span className="badge">{peers.length}</span>
          </div>

          {!connected && (
            <div className="empty-state">
              <WifiOff size={36} className="empty-icon" />
              <p>Connecting to signaling server…</p>
            </div>
          )}

          {connected && peers.length === 0 && (
            <div className="empty-state">
              <Users size={36} className="empty-icon" />
              <p>No peers on the network yet.</p>
              <p className="hint">Open this app in another tab or device on the same network.</p>
            </div>
          )}

          <ul className="peer-list">
            {peers.map((peer) => (
              <li
                key={peer.id}
                className={`peer-card ${selectedPeer?.id === peer.id ? 'peer-card--selected' : ''}`}
                onClick={() => setSelectedPeer((prev) => (prev?.id === peer.id ? null : peer))}
              >
                <div className="peer-avatar">
                  {peer.name.charAt(0)}
                </div>
                <div className="peer-info">
                  <span className="peer-name">{peer.name}</span>
                  <span className="peer-joined">Joined {formatTime(peer.joinedAt)}</span>
                </div>
                <div className="peer-indicator" />
              </li>
            ))}
          </ul>
        </section>

        {/* ── Center: Drop zone ── */}
        <section className="panel panel--drop">
          <div className="panel-header">
            <Upload size={16} />
            <h2>Send a File</h2>
          </div>

          {selectedPeer ? (
            <p className="send-target-label">
              Sending to <strong>{selectedPeer.name}</strong>
            </p>
          ) : (
            <p className="send-target-label hint">Select a peer on the left first</p>
          )}

          <div
            className={`drop-zone ${dragOver ? 'drop-zone--active' : ''} ${!selectedPeer ? 'drop-zone--disabled' : ''}`}
            onDragOver={(e) => { e.preventDefault(); if (selectedPeer) setDragOver(true); }}
            onDragLeave={() => setDragOver(false)}
            onDrop={handleDrop}
            onClick={() => selectedPeer && fileInputRef.current?.click()}
          >
            <input
              ref={fileInputRef}
              type="file"
              style={{ display: 'none' }}
              onChange={handleFileInput}
            />
            <div className="drop-zone-inner">
              <div className={`drop-icon ${dragOver ? 'drop-icon--active' : ''}`}>
                <Upload size={32} />
              </div>
              <p className="drop-primary">
                {dragOver ? 'Release to send' : 'Drop file here'}
              </p>
              <p className="drop-secondary">or click to browse</p>
              <p className="drop-hint">Any file type · No size limit</p>
            </div>
          </div>

          {/* Transfer queue */}
          {transfers.length > 0 && (
            <div className="transfers">
              <h3 className="transfers-heading">
                <HardDrive size={14} /> Transfers
              </h3>
              <ul className="transfer-list">
                {[...transfers].reverse().map((t) => (
                  <li key={t.id} className={`transfer-item transfer-item--${t.status}`}>
                    <span className="transfer-file-icon">{getFileIcon(t.fileName)}</span>
                    <div className="transfer-info">
                      <div className="transfer-top">
                        <span className="transfer-name">{t.fileName}</span>
                        <button
                          className="transfer-dismiss"
                          onClick={() => dismissTransfer(t.id)}
                        >
                          <X size={12} />
                        </button>
                      </div>
                      <div className="transfer-meta">
                        <span>{t.direction === 'send' ? `→ ${t.peerName}` : `← ${t.peerName}`}</span>
                        <span>{formatBytes(t.fileSize)}</span>
                      </div>

                      {t.status !== 'done' && t.status !== 'error' && (
                        <div className="progress-bar">
                          <div
                            className="progress-fill"
                            style={{ width: `${t.progress}%` }}
                          />
                        </div>
                      )}

                      <div className="transfer-status-row">
                        {t.status === 'connecting' && (
                          <><Loader2 size={12} className="spin" /> <span>Connecting…</span></>
                        )}
                        {t.status === 'sending' && (
                          <><Loader2 size={12} className="spin" /> <span>Sending {t.progress}%</span></>
                        )}
                        {t.status === 'receiving' && (
                          <><Loader2 size={12} className="spin" /> <span>Receiving {t.progress}%</span></>
                        )}
                        {t.status === 'done' && t.direction === 'send' && (
                          <><CheckCircle size={12} className="icon-success" /> <span>Sent!</span></>
                        )}
                        {t.status === 'done' && t.direction === 'receive' && t.url && (
                          <a href={t.url} download={t.fileName} className="download-link">
                            <Download size={12} /> Save file
                          </a>
                        )}
                        {t.status === 'error' && (
                          <><AlertCircle size={12} className="icon-error" /> <span>{t.error || 'Failed'}</span></>
                        )}
                      </div>
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </section>

        {/* ── Right panel: Received Files ── */}
        <section className="panel panel--received">
          <div className="panel-header">
            <Download size={16} />
            <h2>Received Files</h2>
            <span className="badge">{incomingFiles.length}</span>
          </div>

          {incomingFiles.length === 0 ? (
            <div className="empty-state">
              <FileText size={36} className="empty-icon" />
              <p>No files received yet.</p>
              <p className="hint">Files sent to you will appear here.</p>
            </div>
          ) : (
            <ul className="received-list">
              {incomingFiles.map((f) => (
                <li key={f.id} className="received-item">
                  <span className="received-file-icon">{getFileIcon(f.name)}</span>
                  <div className="received-info">
                    <span className="received-name">{f.name}</span>
                    <div className="received-meta">
                      <span>{formatBytes(f.size)}</span>
                      <span>from {f.from}</span>
                      <span>{formatTime(f.receivedAt)}</span>
                    </div>
                  </div>
                  <a href={f.url} download={f.name} className="save-btn">
                    <Download size={14} />
                  </a>
                </li>
              ))}
            </ul>
          )}
        </section>
      </main>
    </div>
  );
}
