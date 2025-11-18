// index.js
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const morgan = require('morgan');
const settings = require('./config/settings');
const auditRoutes = require('./routes/audit-routes');
const errorHandler = require('./middleware/error-handler');

// Configure logging
const logLevel = settings.logLevel.toUpperCase();
console.log(`Starting application with log level: ${logLevel}`);

// Initialize Express app
const app = express();
const PORT = process.env.PORT || 8000;
//const HOST = process.env.HOST || "0.0.0.0";

// Apply middleware
app.use(helmet());
app.use(cors({
  origin: settings.corsOriginsList,
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(morgan('combined'));

// Apply routes
app.use('/', auditRoutes);

// Error handling middleware (must be after all routes)
app.use(errorHandler);

// Start the server
app.listen(PORT, () => {
  console.log(`PIP Data API server running on port ${PORT}`);
  console.log(`API docs available at /docs`);
  console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);

  // Log key settings (sanitized)
  // console.log(`OpenSearch host: ${settings.opensearchHost}`);
  console.log(`AWS Region: ${settings.awsRegion}`);
  console.log(`Index names: ${settings.indexNamesList.join(', ')}`);
  console.log(`Collection name: ${settings.collectionName}`);
});

// Handle uncaught exceptions
process.on('uncaughtException', (err) => {
  console.error('Uncaught Exception:', err);
  // Perform graceful shutdown
  process.exit(1);
});

// Handle unhandled rejections
process.on('unhandledRejection', (err) => {
  console.error('Unhandled Rejection:', err);
  // Log but don't exit
});

module.exports = app;

