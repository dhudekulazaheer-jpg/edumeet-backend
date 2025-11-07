const express = require('express');
const http = require('http');
const cors = require('cors');
const { Server } = require('socket.io');
const nodemailer = require('nodemailer');
const xlsx = require('xlsx');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

const app = express();
const server = http.createServer(app);
app.use(cors());

const io = new Server(server, {
  cors: { 
  origin: [
    'https://edumeet-pi.vercel.app',
    'https://edumeet-3ul6dm2ej-dhudekulazaheers-projects.vercel.app',
    'http://localhost:3000'
  ],

  },
  transports: ['websocket', 'polling']
});

const rooms = {};
const attendanceByRoom = {};
const roomCreators = {};
const sessionData = {};

const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS
  }
});

io.on('connection', (socket) => {
  console.log('User connected:', socket.id);

  socket.on('join-room', ({ roomId, userName, name, role, email }) => {
    const finalName = userName || name || 'Anonymous';
    const userEmail = email || 'Not provided';
    
    if (!rooms[roomId]) {
      rooms[roomId] = [];
      roomCreators[roomId] = { socketId: socket.id, name: finalName, email: userEmail };
      socket.isTeacher = true;
      socket.isHost = true;
      sessionData[roomId] = {
        hostEmail: userEmail,
        hostName: finalName,
        startTime: new Date(),
        participants: []
      };
      console.log(`${finalName} created room ${roomId} as host`);
    } else {
      socket.isTeacher = (socket.id === roomCreators[roomId].socketId) || (role === 'teacher');
      socket.isHost = (socket.id === roomCreators[roomId].socketId);
    }
    
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
      rooms[roomId] = rooms[roomId].filter(id => id !== duplicateSocketId);
      if (attendanceByRoom[roomId]) {
        attendanceByRoom[roomId] = attendanceByRoom[roomId].filter(n => n !== finalName);
      }
    }
    
    rooms[roomId].push(socket.id);
    socket.join(roomId);

    attendanceByRoom[roomId] = attendanceByRoom[roomId] || [];
    socket.name = finalName;
    socket.email = userEmail;
    socket.roomId = roomId;
    socket.role = socket.isTeacher ? 'teacher' : 'student';
    socket.joinTime = new Date();
    
    if (sessionData[roomId] && !socket.isHost) {
      sessionData[roomId].participants.push({
        name: finalName,
        email: userEmail,
        joinTime: new Date(),
        leaveTime: null,
        attentionScores: [],
        socketId: socket.id
      });
    }
    
    if (finalName && !attendanceByRoom[roomId].includes(finalName)) {
      attendanceByRoom[roomId].push(finalName);
    }
    io.to(roomId).emit('attendance-update', attendanceByRoom[roomId]);
    socket.emit('role-assigned', { role: socket.role });

    const otherUsers = rooms[roomId].filter(id => id !== socket.id);
    socket.emit('all-users', otherUsers.map(id => ({ socketId: id, userName: finalName })));
    socket.to(roomId).emit('user-joined', { callerId: socket.id, userName: finalName, signal: null });

    console.log(`${finalName} (${userEmail}) joined room ${roomId}`);
  });

  socket.on('attention-update', ({ userName, attentionScore }) => {
    const roomId = socket.roomId;
    if (sessionData[roomId]) {
      const participant = sessionData[roomId].participants.find(p => p.socketId === socket.id);
      if (participant) {
        participant.attentionScores.push(attentionScore);
      }
    }
  });

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

  socket.on('send-message', (data) => {
    io.to(data.roomId).emit('receive-message', {
      userName: data.userName,
      message: data.message,
      time: data.time
    });
  });

  socket.on('kick-user', ({ user }) => {
    const roomId = socket.roomId;
    for (let [sid, s] of io.of("/").sockets) {
      if (s.name === user) {
        s.leave(roomId);
        s.disconnect(true);
      }
    }
    if (roomId && attendanceByRoom[roomId]) {
      attendanceByRoom[roomId] = attendanceByRoom[roomId].filter(name => name !== user);
      io.to(roomId).emit('attendance-update', attendanceByRoom[roomId]);
    }
  });

  socket.on('leave-room', (roomId) => {
    handleUserLeaving(socket, roomId);
  });

  socket.on('disconnect', () => {
    console.log('User disconnected:', socket.id);
    const roomId = socket.roomId;
    handleUserLeaving(socket, roomId);
  });

  function handleUserLeaving(socket, roomId) {
    if (!roomId || !rooms[roomId]) return;

    if (sessionData[roomId] && !socket.isHost) {
      const participant = sessionData[roomId].participants.find(p => p.socketId === socket.id);
      if (participant) {
        participant.leaveTime = new Date();
      }
    }

    if (socket.isHost || socket.id === roomCreators[roomId]?.socketId) {
      console.log(`Host left room ${roomId}. Generating report.`);
      
      if (sessionData[roomId]) {
        generateAndSendReport(roomId);
      }
      
      io.to(roomId).emit('host-left', { message: 'The host has left. This meeting has ended.' });
      
      if (rooms[roomId]) {
        rooms[roomId].forEach(socketId => {
          const participantSocket = io.sockets.sockets.get(socketId);
          if (participantSocket && participantSocket.id !== socket.id) {
            if (sessionData[roomId]) {
              const participant = sessionData[roomId].participants.find(p => p.socketId === socketId);
              if (participant && !participant.leaveTime) {
                participant.leaveTime = new Date();
              }
            }
            participantSocket.disconnect(true);
          }
        });
      }
      
      setTimeout(() => {
        delete rooms[roomId];
        delete attendanceByRoom[roomId];
        delete roomCreators[roomId];
        delete sessionData[roomId];
      }, 5000);
      
    } else {
      rooms[roomId] = rooms[roomId].filter(id => id !== socket.id);
      socket.to(roomId).emit('user-disconnected', socket.id);
      socket.to(roomId).emit('user-left', socket.id);
      
      if (attendanceByRoom[roomId] && socket.name) {
        attendanceByRoom[roomId] = attendanceByRoom[roomId].filter(name => name !== socket.name);
        io.to(roomId).emit('attendance-update', attendanceByRoom[roomId]);
      }
    }
  }

  function generateAndSendReport(roomId) {
    const session = sessionData[roomId];
    if (!session || !session.hostEmail || session.hostEmail === 'Not provided') {
      console.log('No valid host email');
      return;
    }

    const endTime = new Date();
    const sessionDuration = Math.round((endTime - session.startTime) / 1000 / 60);

    const reportData = session.participants.map(p => {
      const joinTime = p.joinTime;
      const leaveTime = p.leaveTime || endTime;
      const duration = Math.round((leaveTime - joinTime) / 1000 / 60);
      const avgAttention = p.attentionScores.length > 0 
        ? Math.round(p.attentionScores.reduce((a, b) => a + b, 0) / p.attentionScores.length)
        : 0;

      return {
        'Student Name': p.name,
        'Email': p.email,
        'Join Time': joinTime.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }),
        'Leave Time': leaveTime.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }),
        'Duration (min)': duration,
        'Avg Attention (%)': avgAttention
      };
    });

    const wb = xlsx.utils.book_new();
    const ws = xlsx.utils.json_to_sheet(reportData);
    xlsx.utils.book_append_sheet(wb, ws, 'Attendance');

    const fileName = `attendance_${roomId}_${Date.now()}.xlsx`;
    const filePath = path.join(__dirname, fileName);
    xlsx.writeFile(wb, filePath);

    const mailOptions = {
      from: process.env.EMAIL_USER,
      to: session.hostEmail,
      subject: `EduMeet Session Report - ${session.startTime.toLocaleDateString()}`,
      html: `
        <h2>📊 Session Attendance Report</h2>
        <p><strong>Host:</strong> ${session.hostName}</p>
        <p><strong>Started:</strong> ${session.startTime.toLocaleString('en-IN')}</p>
        <p><strong>Ended:</strong> ${endTime.toLocaleString('en-IN')}</p>
        <p><strong>Duration:</strong> ${sessionDuration} minutes</p>
        <p><strong>Participants:</strong> ${session.participants.length}</p>
        <br><p>Detailed report attached.</p>
        <p><em>Generated by EduMeet</em></p>
      `,
      attachments: [{ filename: fileName, path: filePath }]
    };

    transporter.sendMail(mailOptions, (error, info) => {
      if (error) {
        console.log('Email error:', error);
      } else {
        console.log('Email sent:', info.response);
        fs.unlinkSync(filePath);
      }
    });
  }
});

server.listen(5000, () => console.log('Server running on port 5000'));
