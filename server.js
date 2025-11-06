const express = require('express');
const http = require('http');
const cors = require('cors');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);

app.use(cors());

const io = new Server(server, {
  cors: { 
    origin: 'https://edumeet-3ul6dm2ej-dhudekulazaheers-projects.vercel.app',
    methods: ["GET", "POST"]
  },
  transports: ['websocket', 'polling']
});

const rooms = {};
const attendanceByRoom = {}; // Track attendance by name per room
const roomCreators = {}; // Track who created each room

io.on('connection', (socket) => {
  console.log('User connected:', socket.id);

  socket.on('join-room', ({ roomId, userName, name, role }) => {
    const finalName = userName || name || 'Anonymous';
    
    // If room doesn't exist, this user is the creator/teacher
    if (!rooms[roomId]) {
      rooms[roomId] = [];
      roomCreators[roomId] = socket.id;
      socket.isTeacher = true;
      console.log(`${finalName} created room ${roomId} as teacher`);
    } else {
      // Check if this socket is the creator
      socket.isTeacher = (socket.id === roomCreators[roomId]) || (role === 'teacher');
    }
    
    // **NEW: Check for duplicate users and remove old connection**
    const duplicateSocketId = rooms[roomId].find(id => {
      const existingSocket = io.sockets.sockets.get(id);
      return existingSocket && existingSocket.name === finalName && id !== socket.id;
    });
    
    if (duplicateSocketId) {
      console.log(`Removing duplicate connection for ${finalName}`);
      const oldSocket = io.sockets.sockets.get(duplicateSocketId);
      if (oldSocket) {
        oldSocket.emit('duplicate-connection', { message: 'You joined from another device' });
        oldSocket.disconnect(true);
      }
      // Remove from rooms array
      rooms[roomId] = rooms[roomId].filter(id => id !== duplicateSocketId);
      
      // Remove from attendance
      if (attendanceByRoom[roomId]) {
        attendanceByRoom[roomId] = attendanceByRoom[roomId].filter(n => n !== finalName);
      }
    }
    
    rooms[roomId].push(socket.id);
    socket.join(roomId);

    // Attendance tracking
    attendanceByRoom[roomId] = attendanceByRoom[roomId] || [];
    socket.name = finalName;
    socket.roomId = roomId;
    socket.role = socket.isTeacher ? 'teacher' : 'student';
    
    if (finalName && !attendanceByRoom[roomId].includes(finalName)) {
      attendanceByRoom[roomId].push(finalName);
    }
    io.to(roomId).emit('attendance-update', attendanceByRoom[roomId]);

    // Send role back to client
    socket.emit('role-assigned', { role: socket.role });

    // Inform the new user about existing participants
    const otherUsers = rooms[roomId].filter(id => id !== socket.id);
    socket.emit('all-users', otherUsers.map(id => ({
      socketId: id,
      userName: finalName
    })));

    // Notify others that a new user joined
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
