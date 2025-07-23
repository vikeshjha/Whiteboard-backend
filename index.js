const express = require('express');
const http = require('http');
const cors = require('cors');
const { Server } = require('socket.io');
const connectDB = require('./config/database');
const User = require('./models/User');
const Room = require('./models/Room');
const { generateToken, authenticateToken } = require('./utils/jwt');

// Load environment variables
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// Connect to database
connectDB();

// Enhanced CORS configuration for Render deployment
app.use(cors({
  origin: [
    'http://localhost:3000',
    'http://localhost:5173', // Vite dev server
    'https://vikesh-whiteboard.netlify.app', // Your deployed frontend
    'https://collaborative-whiteboard-480h.onrender.com' // Your Render backend URL
  ],
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'Accept']
}));

app.use(express.json());

// Request logging middleware for debugging
app.use((req, res, next) => {
  console.log(`${new Date().toISOString()} - ${req.method} ${req.path}`);
  if (req.headers.authorization) {
    console.log('Auth header present:', req.headers.authorization.substring(0, 20) + '...');
  }
  if (req.body && Object.keys(req.body).length > 0) {
    console.log('Request body:', JSON.stringify(req.body, null, 2));
  }
  next();
});

// Utility functions
const genRoomCode = () => {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let result = '';
  for (let i = 0; i < 6; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
};

// Root endpoint with better info
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

// Authentication routes with better error handling
app.post('/api/register', async (req, res) => {
  console.log('=== REGISTER REQUEST ===');
  console.log('Body received:', req.body);
  
  const { username, email, password } = req.body;

  // Validation
  if (!username || !email || !password) {
    console.log('Validation failed: Missing fields');
    return res.status(400).json({ 
      error: 'Username, email, and password are required' 
    });
  }

  // Email format validation
  if (!email.match(/^[a-zA-Z0-9._%+-]+@gmail\.com$/)) {
    console.log('Validation failed: Email format');
    return res.status(400).json({ 
      error: 'Email must be in format: xyz@gmail.com' 
    });
  }

  // Password length validation
  if (password.length < 6) {
    console.log('Validation failed: Password length');
    return res.status(400).json({ 
      error: 'Password must be at least 6 characters' 
    });
  }

  try {
    console.log('Checking for existing user...');
    
    // Check if user already exists
    const existingUser = await User.findOne({
      $or: [{ username }, { email }]
    });

    if (existingUser) {
      const field = existingUser.email === email ? 'email' : 'username';
      console.log(`User exists: ${field}`);
      return res.status(409).json({ 
        error: `User with this ${field} already exists` 
      });
    }

    console.log('Creating new user...');
    
    // Create new user
    const user = new User({ username, email, password });
    await user.save();

    console.log('User registered successfully:', username);
    res.status(201).json({ 
      success: true,
      message: 'Registration successful! Please login.'
    });

  } catch (error) {
    console.error('Registration error:', error);
    
    // Handle validation errors
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
  console.log('=== LOGIN REQUEST ===');
  console.log('Body received:', req.body);
  
  const { username, password } = req.body;

  if (!username || !password) {
    console.log('Validation failed: Missing credentials');
    return res.status(400).json({ 
      error: 'Username/email and password are required' 
    });
  }

  try {
    console.log('Finding user:', username);
    
    // Find user by username or email
    const user = await User.findOne({
      $or: [{ username }, { email: username }]
    });

    if (!user) {
      console.log('User not found');
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    if (!user.isActive) {
      console.log('User is inactive');
      return res.status(401).json({ error: 'Account is inactive' });
    }

    console.log('User found, comparing password...');
    
    // Compare password
    const isMatch = await user.comparePassword(password);
    if (!isMatch) {
      console.log('Password mismatch');
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    // Update last login
    user.lastLogin = new Date();
    await user.save();

    // Generate JWT token
    const token = generateToken(user._id);

    console.log('Login successful for user:', username);
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
    console.error('Login error:', error);
    res.status(500).json({ 
      error: 'Login failed',
      details: error.message 
    });
  }
});

// Protected route - Get user profile
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

// Room creation with better logging
app.post('/api/create-room', authenticateToken, async (req, res) => {
  console.log('=== CREATE ROOM REQUEST ===');
  console.log('User ID:', req.userId);
  console.log('Request body:', req.body);
  
  const { roomName } = req.body;
  const userId = req.userId;

  if (!roomName || !roomName.trim()) {
    console.log('Validation failed: Room name required');
    return res.status(400).json({ error: 'Room name is required' });
  }

  try {
    // Generate unique room code
    let code;
    let existingRoom;
    let attempts = 0;
    
    do {
      code = genRoomCode();
      existingRoom = await Room.findOne({ code: code.toUpperCase() });
      attempts++;
      console.log(`Room code generation attempt ${attempts}: ${code}`);
    } while (existingRoom && attempts < 10);

    if (existingRoom) {
      console.log('Failed to generate unique room code after 10 attempts');
      return res.status(500).json({ error: 'Failed to generate unique room code' });
    }

    const finalCode = code.toUpperCase();
    console.log('Final room code:', finalCode);

    // Create new room
    const room = new Room({
      code: finalCode,
      room_name: roomName.trim(),
      creator: userId,
      members: [userId]
    });

    await room.save();
    console.log('Room created successfully:', {
      code: room.code,
      name: room.room_name,
      creator: room.creator
    });
    
    res.status(201).json({ 
      roomCode: finalCode,
      roomName: roomName.trim(),
      message: 'Room created successfully'
    });

  } catch (error) {
    console.error('Create room error:', error);
    res.status(500).json({ 
      error: 'Room creation failed',
      details: error.message 
    });
  }
});

// Room verification with better debugging
app.post('/api/verify-room', authenticateToken, async (req, res) => {
  console.log('=== VERIFY ROOM REQUEST ===');
  console.log('User ID:', req.userId);
  console.log('Request body:', req.body);
  
  const { roomCode } = req.body;

  if (!roomCode || !roomCode.trim()) {
    console.log('Validation failed: Room code required');
    return res.status(400).json({ error: 'Room code is required' });
  }

  try {
    const cleanCode = roomCode.trim().toUpperCase();
    console.log('Searching for room with cleaned code:', cleanCode);
    
    // Search for room with case-insensitive and trimmed code
    const room = await Room.findOne({ code: cleanCode });
    
    console.log('Database query result:', room ? {
      code: room.code,
      name: room.room_name,
      members: room.members.length
    } : 'null');
    
    if (!room) {
      console.log('Room not found for code:', cleanCode);
      
      // Debug: List all existing rooms
      const allRooms = await Room.find({}).select('code room_name creator');
      console.log('All existing rooms in database:', allRooms);
      
      return res.status(404).json({ 
        error: `Room with code "${cleanCode}" not found`,
        availableRooms: allRooms.length
      });
    }

    // Add user to room members if not already there
    const userId = req.userId;
    if (!room.members.includes(userId)) {
      room.members.push(userId);
      await room.save();
      console.log('User added to room members');
    } else {
      console.log('User already in room members');
    }

    console.log('Room verification successful');
    res.json({ 
      room: { 
        room_name: room.room_name,
        code: room.code,
        memberCount: room.members.length
      },
      message: 'Room found successfully'
    });

  } catch (error) {
    console.error('Verify room error:', error);
    res.status(500).json({ 
      error: 'Room verification failed',
      details: error.message 
    });
  }
});

// Debug endpoint with better info
app.get('/api/debug/rooms', authenticateToken, async (req, res) => {
  try {
    console.log('Debug rooms request from user:', req.userId);
    
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
    
    console.log(`Found ${rooms.length} rooms in database`);
    
    res.json({ 
      rooms: roomsWithDetails,
      totalCount: rooms.length,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('Debug rooms error:', error);
    res.status(500).json({ 
      error: 'Failed to fetch rooms',
      details: error.message 
    });
  }
});

// Socket.IO setup with updated CORS and FIXED event handlers
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
  console.log('🔌 Socket connection established:', socket.id);

  socket.on('join-room', async (roomCode) => {
    try {
      const upperRoomCode = roomCode.toUpperCase();
      socket.join(upperRoomCode);
      console.log(`🏠 Socket ${socket.id} joined room ${upperRoomCode}`);
      
      // Debug: Show room members
      const room = io.sockets.adapter.rooms.get(upperRoomCode);
      console.log(`👥 Room ${upperRoomCode} now has ${room?.size || 0} members`);

      // Load existing canvas data for the room
      const roomData = await Room.findOne({ code: upperRoomCode });
      if (roomData && roomData.canvasData) {
        console.log(`📤 Sending existing canvas data to ${socket.id}`);
        socket.emit('canvas-data', { imageData: roomData.canvasData });
      }
    } catch (error) {
      console.error('❌ Error joining room:', error);
    }
  });

  // ADDED: Real-time drawing data handler
  socket.on('drawing-data', async (data) => {
    try {
      const { roomCode, prevX, prevY, currentX, currentY, color, size, tool } = data;
      const upperRoomCode = roomCode.toUpperCase();
      
      console.log(`🎨 Broadcasting drawing data to room: ${upperRoomCode}`);
      
      // Broadcast drawing data to other users in real-time
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
      console.error('❌ Error handling drawing data:', error);
    }
  });

  socket.on('canvas-data', async ({ roomCode, imageData }) => {
    try {
      const upperRoomCode = roomCode.toUpperCase();
      
      console.log(`📤 Broadcasting full canvas data to room: ${upperRoomCode}`);
      console.log(`👥 Users in room: ${io.sockets.adapter.rooms.get(upperRoomCode)?.size || 0}`);
      console.log(`📏 Image data length: ${imageData?.length || 0}`);
      
      // Broadcast to other users in the room (excluding sender)
      socket.to(upperRoomCode).emit('canvas-data', { imageData });
      
      // Save to database
      await Room.findOneAndUpdate(
        { code: upperRoomCode },
        { canvasData: imageData },
        { upsert: false }
      );
      
      console.log(`✅ Canvas data saved and broadcasted for room ${upperRoomCode}`);
    } catch (error) {
      console.error('❌ Error handling canvas data:', error);
    }
  });

  socket.on('clear-canvas', async (roomCode) => {
    try {
      const upperRoomCode = roomCode.toUpperCase();
      
      console.log(`🗑️ Broadcasting clear canvas to room: ${upperRoomCode}`);
      
      // Broadcast clear to other users
      socket.to(upperRoomCode).emit('clear-canvas');
      
      // Clear canvas data in database
      await Room.findOneAndUpdate(
        { code: upperRoomCode },
        { canvasData: '' }
      );
      
      console.log(`✅ Canvas cleared for room ${upperRoomCode}`);
    } catch (error) {
      console.error('❌ Error clearing canvas data:', error);
    }
  });

  socket.on('disconnect', () => {
    console.log('❌ Socket disconnected:', socket.id);
  });
});

// Start server
httpServer.listen(PORT, () => {
  console.log(`🌐 Backend running on port ${PORT}`);
  console.log(`📍 Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log(`🔗 CORS origins configured for production deployment`);
});
