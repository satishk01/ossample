// middleware/error-handler.js

/**
 * Custom error handler middleware for Express
 */
function errorHandler(err, req, res, next) {
  console.error(`[ERROR] ${err.stack || err.message || err}`);
  
  // If the error has a status code, use it, otherwise default to 500
  const statusCode = err.statusCode || 500;
  
  // Create error response
  const errorResponse = {
    status_code: statusCode,
    detail: err.message || 'Internal Server Error'
  };
  
  // Add error object for non-production environments
  if (process.env.NODE_ENV !== 'production') {
    errorResponse.error = err.stack || err.toString();
  }
  
  // Send error response
  res.status(statusCode).json(errorResponse);
}

module.exports = errorHandler;

