// Every page opens its connection through here: const socket = connectSocket();
//
// WebSocket first. Socket.IO normally starts with HTTP long-polling, which only works if every request of a
// connection reaches the same server process. Vercel runs the server as serverless functions and spreads those
// requests across instances, so connecting often failed or sat for 25 seconds. A WebSocket is one connection,
// so it doesn't have that problem. Polling is kept as the fallback for networks that block WebSockets.

window.connectSocket = () => io({ transports: ['websocket', 'polling'], tryAllTransports: true });
