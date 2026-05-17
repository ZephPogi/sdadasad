# Parallel - P2P File Sharing Application

A localized peer-to-peer file sharing application built with React, Vite, and WebRTC, using Socket.io for signaling.

## Features
- **Direct P2P Transfer**: Files are sent directly between devices using WebRTC Data Channels.
- **Fast & Secure**: File data does not pass through a central server, maximizing transfer speed and ensuring privacy.
- **Cross-Device**: Share files easily between desktop and mobile devices on the same network.
- **Ordered Transfer**: Guarantees file integrity during transfer over the WebRTC data channel.

## How the Peer-to-Peer System Works

The application utilizes a hybrid architecture to establish peer-to-peer connections:

1. **The Signaling Server (Backend):**
   - WebRTC requires peers to exchange connection information (SDP offers/answers and ICE candidates) before a direct connection can be established. 
   - The Node.js + Socket.io backend acts *strictly* as a signaling server. It maintains a list of connected users and relays these initial negotiation messages between peers.
   - **No file data ever touches the backend.** It is only used for the initial "handshake."

2. **The WebRTC Connection (Frontend):**
   - Once the signaling handshake is complete via Socket.io, an `RTCPeerConnection` is established directly between the two clients.
   - The application uses public STUN servers (e.g., Google's STUN servers) to help peers discover their public IP addresses for NAT traversal.

3. **File Transfer via Data Channels:**
   - After the peer connection is active, the initiating peer creates an `RTCDataChannel` specifically configured for ordered, reliable delivery.
   - Files are read as `ArrayBuffer` chunks and sent directly over this secure WebRTC data channel to the receiving peer, where they are reassembled and downloaded.

## Project Structure
- `backend/`: Node.js signaling server using Express and Socket.io.
- `frontend/`: React frontend built with Vite.

## Getting Started

### Prerequisites
- Node.js (v16 or higher)
- npm

### Installation

1. Install Backend dependencies:
   ```bash
   cd backend
   npm install
   ```

2. Install Frontend dependencies:
   ```bash
   cd ../frontend
   npm install
   ```

### Running the Application

To run the application locally, you will need two terminal windows.

1. **Start the Backend Server (Terminal 1)**:
   ```bash
   cd backend
   npm start
   ```
   The signaling server will start on port 3001 (or as defined by your environment variables).

2. **Start the Frontend Development Server (Terminal 2)**:
   ```bash
   cd frontend
   npm run dev
   ```
   The application will usually be available at `http://localhost:5173`. 
   
   *Tip: To test cross-device sharing on your local network, you can run the frontend with `npm run dev -- --host` to expose it to your local network IP.*

## Tech Stack
- **Frontend**: React, Vite, WebRTC (Data Channels)
- **Backend**: Node.js, Express, Socket.io
