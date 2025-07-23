const express = require('express');
const http = require('http');
const cors = require('cors');
const { Server } = require('socket.io');
const connectDB = require('./config/database');
const User = require('./models/User');
const Room = require('./models/Room');
const { generateToken, authenticateToken } = require('./utils/jwt');

require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

connectDB();

app.use(cors({
  origin: [
    'http://localhost:3000',
    'http://localhost:5173',
    'https://vikesh-whiteboard.netlify.app',
    'https://collaborative-whiteboard-480h.onrender.com'
  ],
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'Accept']
}));

app.use(express.json());

const genRoomCode = () => {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let result = '';
  for (let i = 0; i < 6; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
};

app.get('/', (req, res) => {
  res.json({
    message: "Collaborative Whiteboard API is running!",
    status: "success",
    timestamp: new Date().toISOString(),
    environment: process.env.NODE_ENV || 'development',
    endpoints: {
      auth: {
        register: 'POST /api/register',
        login: 'POST /api/login'
      },
      rooms: {
        create: 'POST /api/create-room',
        verify: 'POST /api/verify-room',
        debug: 'GET /api/debug/rooms'
      }
    }
  });
});

app.post('/api/register', async (req, res) => {
  const { username, email, password } = req.body;

  if (!username || !email || !password) {
    return res.status(400).json({ 
      error: 'Username, email, and password are required' 
    });
  }

  if (!email.match(/^[a-zA-Z0-9._%+-]+@gmail\.com$/)) {
    return res.status(400).json({ 
      error: 'Email must be in format: xyz@gmail.com' 
    });
  }

  if (password.length < 6) {
    return res.status(400).json({ 
      error: 'Password must be at least 6 characters' 
    });
  }

  try {
    const existingUser = await User.findOne({
      $or: [{ username }, { email }]
    });

    if (existingUser) {
      const field = existingUser.email === email ? 'email' : 'username';
      return res.status(409).json({ 
        error: `User with this ${field} already exists` 
      });
    }

    const user = new User({ username, email, password });
    await user.save();

    res.status(201).json({ 
      success: true,
      message: 'Registration successful! Please login.'
    });

  } catch (error) {
    if (error.name === 'ValidationError') {
      const errors = Object.values(error.errors).map(err => err.message);
      return res.status(400).json({ error: errors.join(', ') });
    }

    res.status(500).json({ 
      error: 'Registration failed',
      details: error.message 
    });
  }
});

app.post('/api/login', async (req, res) => {
  const { username, password } = req.body;

  if (!username || !password) {
    return res.status(400).json({ 
      error: 'Username/email and password are required' 
    });
  }

  try {
    const user = await User.findOne({
      $or: [{ username }, { email: username }]
    });

    if (!user) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    if (!user.isActive) {
      return res.status(401).json({ error: 'Account is inactive' });
    }

    const isMatch = await user.comparePassword(password);
    if (!isMatch) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    user.lastLogin = new Date();
    await user.save();

    const token = generateToken(user._id);

    res.json({ 
      success: true,
      user: { 
        id: user._id, 
        username: user.username,
        email: user.email 
      },
      token,
      message: 'Login successful'
    });

  } catch (error) {
    res.status(500).json({ 
      error: 'Login failed',
      details: error.message 
    });
  }
});

app.get('/api/profile', authenticateToken, async (req, res) => {
  try {
    const user = await User.findById(req.userId).select('-password');
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }
    res.json({ user });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch profile' });
  }
});

app.post('/api/create-room', authenticateToken, async (req, res) => {
  const { roomName } = req.body;
  const userId = req.userId;

  if (!roomName || !roomName.trim()) {
    return res.status(400).json({ error: 'Room name is required' });
  }

  try {
    let code;
    let existingRoom;
    let attempts = 0;
    
    do {
      code = genRoomCode();
      existingRoom = await Room.findOne({ code: code.toUpperCase() });
      attempts++;
    } while (existingRoom && attempts < 10);

    if (existingRoom) {
      return res.status(500).json({ error: 'Failed to generate unique room code' });
    }

    const finalCode = code.toUpperCase();

    const room = new Room({
      code: finalCode,
      room_name: roomName.trim(),
      creator: userId,
      members: [userId]
    });

    await room.save();
    
    res.status(201).json({ 
      roomCode: finalCode,
      roomName: roomName.trim(),
      message: 'Room created successfully'
    });

  } catch (error) {
    res.status(500).json({ 
      error: 'Room creation failed',
      details: error.message 
    });
  }
});

app.post('/api/verify-room', authenticateToken, async (req, res) => {
  const { roomCode } = req.body;

  if (!roomCode || !roomCode.trim()) {
    return res.status(400).json({ error: 'Room code is required' });
  }

  try {
    const cleanCode = roomCode.trim().toUpperCase();
    const room = await Room.findOne({ code: cleanCode });
    
    if (!room) {
      return res.status(404).json({ 
        error: `Room with code "${cleanCode}" not found`
      });
    }

    const userId = req.userId;
    if (!room.members.includes(userId)) {
      room.members.push(userId);
      await room.save();
    }

    res.json({ 
      room: { 
        room_name: room.room_name,
        code: room.code,
        memberCount: room.members.length
      },
      message: 'Room found successfully'
    });

  } catch (error) {
    res.status(500).json({ 
      error: 'Room verification failed',
      details: error.message 
    });
  }
});

app.get('/api/debug/rooms', authenticateToken, async (req, res) => {
  try {
    const rooms = await Room.find({})
      .select('code room_name creator members createdAt')
      .populate('creator', 'username')
      .sort({ createdAt: -1 });
    
    const roomsWithDetails = rooms.map(room => ({
      code: room.code,
      name: room.room_name,
      creator: room.creator?.username || 'Unknown',
      memberCount: room.members.length,
      created: room.createdAt
    }));
    
    res.json({ 
      rooms: roomsWithDetails,
      totalCount: rooms.length,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    res.status(500).json({ 
      error: 'Failed to fetch rooms',
      details: error.message 
    });
  }
});

const httpServer = http.createServer(app);
const io = new Server(httpServer, { 
  cors: { 
    origin: [
      'http://localhost:3000',
      'http://localhost:5173',
      'https://vikesh-whiteboard.netlify.app',
      'https://collaborative-whiteboard-480h.onrender.com'
    ],
    methods: ["GET", "POST"],
    credentials: true
  } 
});

io.on('connection', socket => {
  socket.on('join-room', async (roomCode) => {
    try {
      const upperRoomCode = roomCode.toUpperCase();
      socket.join(upperRoomCode);

      const roomData = await Room.findOne({ code: upperRoomCode });
      if (roomData && roomData.canvasData) {
        socket.emit('canvas-data', { imageData: roomData.canvasData });
      }
    } catch (error) {
      console.error('Error joining room:', error);
    }
  });

  socket.on('drawing-data', async (data) => {
    try {
      const { roomCode, prevX, prevY, currentX, currentY, color, size, tool } = data;
      const upperRoomCode = roomCode.toUpperCase();
      
      socket.to(upperRoomCode).emit('drawing-data', {
        prevX,
        prevY,
        currentX,
        currentY,
        color,
        size,
        tool
      });
      
    } catch (error) {
      console.error('Error handling drawing data:', error);
    }
  });

  socket.on('canvas-data', async ({ roomCode, imageData }) => {
    try {
      const upperRoomCode = roomCode.toUpperCase();
      
      socket.to(upperRoomCode).emit('canvas-data', { imageData });
      
      await Room.findOneAndUpdate(
        { code: upperRoomCode },
        { canvasData: imageData },
        { upsert: false }
      );
      
    } catch (error) {
      console.error('Error handling canvas data:', error);
    }
  });

  socket.on('clear-canvas', async (roomCode) => {
    try {
      const upperRoomCode = roomCode.toUpperCase();
      
      socket.to(upperRoomCode).emit('clear-canvas');
      
      await Room.findOneAndUpdate(
        { code: upperRoomCode },
        { canvasData: '' }
      );
      
    } catch (error) {
      console.error('Error clearing canvas data:', error);
    }
  });

  socket.on('disconnect', () => {
    console.log('Socket disconnected:', socket.id);
  });
});

httpServer.listen(PORT, () => {
  console.log(`Backend running on port ${PORT}`);
});
