const express = require('express');
const http = require('http');
const cors = require('cors');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);

app.use(cors());

const io = new Server(server, {
  cors: { 
    origin: '*',
    methods: ["GET", "POST"]
  },
  transports: ['websocket', 'polling']
});

const rooms = {};
const attendanceByRoom = {}; // Track attendance by name per room

io.on('connection', (socket) => {
  console.log('User connected:', socket.id);

  socket.on('join-room', ({ roomId, userName, name, role }) => {
    const finalName = userName || name || 'Anonymous';
    
    if (!rooms[roomId]) rooms[roomId] = [];
    rooms[roomId].push(socket.id);
    socket.join(roomId);

    // Attendance tracking
    attendanceByRoom[roomId] = attendanceByRoom[roomId] || [];
    socket.name = finalName; // Save user's name on socket
    socket.roomId = roomId;
    
    if (finalName && !attendanceByRoom[roomId].includes(finalName)) {
      attendanceByRoom[roomId].push(finalName);
    }
    io.to(roomId).emit('attendance-update', attendanceByRoom[roomId]);

    // Inform the new user about existing participants
    const otherUsers = rooms[roomId].filter(id => id !== socket.id);
    socket.emit('all-users', otherUsers.map(id => ({
      socketId: id,
      userName: finalName
    })));

    // Notify others that a new user joined - FIXED EVENT NAME
    socket.to(roomId).emit('user-joined', {
      callerId: socket.id,
      userName: finalName,
      signal: null
    });

    console.log(`${finalName} joined room ${roomId}`);
  });

  // WebRTC signaling
  socket.on('sending-signal', payload => {
    io.to(payload.userToSignal).emit('user-joined', { 
      signal: payload.signal, 
      callerId: payload.callerId,
      userName: payload.userName || socket.name
    });
  });

  socket.on('returning-signal', payload => {
    io.to(payload.callerId).emit('receiving-returned-signal', { 
      signal: payload.signal, 
      id: socket.id 
    });
  });

  // --- CHAT Feature ---
  socket.on('chat-message', msg => {
    const roomId = socket.roomId;
    if (roomId) {
      io.to(roomId).emit('chat-message', msg);
    }
  });

  // New chat message format from Room.js
  socket.on('send-message', (data) => {
    io.to(data.roomId).emit('receive-message', {
      userName: data.userName,
      message: data.message,
      time: data.time
    });
  });

  // --- ADMIN KICK Feature ---
  socket.on('kick-user', ({ user }) => {
    const roomId = socket.roomId;
    // Find and disconnect the socket for the given user
    for (let [sid, s] of io.of("/").sockets) {
      if (s.name === user) {
        s.leave(roomId);
        s.disconnect(true);
      }
    }
    // Remove user from attendance
    if (roomId && attendanceByRoom[roomId]) {
      attendanceByRoom[roomId] = attendanceByRoom[roomId].filter(name => name !== user);
      io.to(roomId).emit('attendance-update', attendanceByRoom[roomId]);
    }
  });

  // Leave room
  socket.on('leave-room', (roomId) => {
    if (rooms[roomId]) {
      rooms[roomId] = rooms[roomId].filter(id => id !== socket.id);
      socket.to(roomId).emit('user-disconnected', socket.id);
    }
    if (attendanceByRoom[roomId] && socket.name) {
      attendanceByRoom[roomId] = attendanceByRoom[roomId].filter(name => name !== socket.name);
      io.to(roomId).emit('attendance-update', attendanceByRoom[roomId]);
    }
  });

  // --- DISCONNECT ---
  socket.on('disconnect', () => {
    console.log('User disconnected:', socket.id);
    const roomId = socket.roomId;
    
    // Remove from room
    if (roomId && rooms[roomId]) {
      rooms[roomId] = rooms[roomId].filter(id => id !== socket.id);
      socket.to(roomId).emit('user-disconnected', socket.id);
      socket.to(roomId).emit('user-left', socket.id);
    }
    
    // Remove from attendance
    if (roomId && attendanceByRoom[roomId] && socket.name) {
      attendanceByRoom[roomId] = attendanceByRoom[roomId].filter(name => name !== socket.name);
      io.to(roomId).emit('attendance-update', attendanceByRoom[roomId]);
    }
  });
});

server.listen(5000, () => console.log('Server running on port 5000'));
