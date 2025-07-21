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

// UPDATED: CORS Middleware with your frontend URL
app.use(cors({ 
  origin: [
    'http://localhost:3000',
    'http://localhost:5173', // Vite dev server
    'https://vikesh-whiteboard.netlify.app' // Your deployed frontend
  ],
  credentials: true
}));
app.use(express.json());

// Utility functions
const genRoomCode = () => {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
  let result = '';
  for (let i = 0; i < 6; i++) {
    result += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return result;
};

app.get('/',(req, res) =>{
  res.json("server is running")
})

// Enhanced Authentication routes
app.post('/api/register', async (req, res) => {
  console.log('Register attempt:', req.body);
  const { username, email, password } = req.body;

  // Validation
  if (!username || !email || !password) {
    return res.status(400).json({ 
      error: 'Username, email, and password are required' 
    });
  }

  // Email format validation
  if (!email.match(/^[a-zA-Z0-9._%+-]+@gmail\.com$/)) {
    return res.status(400).json({ 
      error: 'Email must be in format: xyz@gmail.com' 
    });
  }

  // Password length validation
  if (password.length < 6) {
    return res.status(400).json({ 
      error: 'Password must be at least 6 characters' 
    });
  }

  try {
    // Check if user already exists
    const existingUser = await User.findOne({
      $or: [{ username }, { email }]
    });

    if (existingUser) {
      const field = existingUser.email === email ? 'email' : 'username';
      return res.status(409).json({ 
        error: `User with this ${field} already exists` 
      });
    }

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

    res.status(500).json({ error: 'Registration failed' });
  }
});

app.post('/api/login', async (req, res) => {
  console.log('Login attempt:', req.body);
  const { username, password } = req.body;

  if (!username || !password) {
    return res.status(400).json({ 
      error: 'Username/email and password are required' 
    });
  }

  try {
    // Find user by username or email
    const user = await User.findOne({
      $or: [{ username }, { email: username }]
    });

    if (!user || !user.isActive) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    // Compare password
    const isMatch = await user.comparePassword(password);
    if (!isMatch) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    // Update last login
    user.lastLogin = new Date();
    await user.save();

    // Generate JWT token
    const token = generateToken(user._id);

    console.log('Login successful:', username);
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
    res.status(500).json({ error: 'Login failed' });
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

// FIXED: Protected Room management routes
app.post('/api/create-room', authenticateToken, async (req, res) => {
  console.log('Create room attempt:', req.body);
  const { roomName } = req.body;
  const userId = req.userId;

  if (!roomName) {
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
    } while (existingRoom && attempts < 10);

    if (existingRoom) {
      return res.status(500).json({ error: 'Failed to generate unique room code' });
    }

    console.log('Generated room code:', code);

    // Create new room
    const room = new Room({
      code: code.toUpperCase(),
      room_name: roomName,
      creator: userId,
      members: [userId]
    });

    await room.save();
    console.log('Room created successfully:', room);
    
    res.status(201).json({ roomCode: code.toUpperCase() });

  } catch (error) {
    console.error('Create room error:', error);
    res.status(500).json({ error: 'Room creation failed' });
  }
});

// FIXED: Verify room endpoint with proper case handling
app.post('/api/verify-room', authenticateToken, async (req, res) => {
  console.log('Verify room attempt:', req.body);
  const { roomCode } = req.body;

  if (!roomCode) {
    return res.status(400).json({ error: 'Room code is required' });
  }

  try {
    // Search for room with case-insensitive and trimmed code
    const room = await Room.findOne({ 
      code: roomCode.trim().toUpperCase()
    });
    
    console.log('Searching for room with code:', roomCode.trim().toUpperCase());
    console.log('Room found:', room);
    
    if (!room) {
      console.log('Room not found for code:', roomCode);
      
      // Debug: List all existing rooms
      const allRooms = await Room.find({}).select('code room_name');
      console.log('All existing rooms:', allRooms);
      
      return res.status(404).json({ error: 'Room not found' });
    }

    // Add user to room members if not already there
    const userId = req.userId;
    if (!room.members.includes(userId)) {
      room.members.push(userId);
      await room.save();
      console.log('User added to room members');
    }

    res.json({ room: { room_name: room.room_name } });
  } catch (error) {
    console.error('Verify room error:', error);
    res.status(500).json({ error: 'Room verification failed' });
  }
});

// Debug endpoint to check existing rooms
app.get('/api/debug/rooms', authenticateToken, async (req, res) => {
  try {
    const rooms = await Room.find({}).select('code room_name creator createdAt');
    res.json({ rooms });
  } catch (error) {
    res.status(500).json({ error: 'Failed to fetch rooms' });
  }
});

// UPDATED: Socket.IO setup with proper CORS
const httpServer = http.createServer(app);
const io = new Server(httpServer, { 
  cors: { 
    origin: [
      'http://localhost:3000',
      'http://localhost:5173',
      'https://vikesh-whiteboard.netlify.app'
    ],
    methods: ["GET", "POST"],
    credentials: true
  } 
});

io.on('connection', socket => {
  console.log('Socket connection established:', socket.id);

  socket.on('join-room', async (roomCode) => {
    socket.join(roomCode);
    console.log(`Socket ${socket.id} joined room ${roomCode}`);

    try {
      const room = await Room.findOne({ code: roomCode });
      if (room && room.canvasData) {
        socket.emit('canvas-data', { imageData: room.canvasData });
      }
    } catch (error) {
      console.error('Error loading canvas data:', error);
    }
  });

  socket.on('canvas-data', async ({ room, imageData }) => {
    socket.to(room).emit('canvas-data', { imageData });
    
    try {
      await Room.findOneAndUpdate(
        { code: room },
        { canvasData: imageData },
        { upsert: false }
      );
    } catch (error) {
      console.error('Error saving canvas data:', error);
    }
  });

  socket.on('clear-canvas', async (room) => {
    socket.to(room).emit('clear-canvas');
    
    try {
      await Room.findOneAndUpdate(
        { code: room },
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

httpServer.listen(PORT, () =>
  console.log(`🌐 Backend running on http://localhost:${PORT}`)
);
