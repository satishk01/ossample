// middleware/validation.js

/**
 * Express middleware for validating requests using Joi schemas
 * @param {Object} schemas - Object containing Joi schemas for body, query, params
 * @returns {Function} Express middleware
 */
function validateRequest(schemas) {
  return (req, res, next) => {
    // Validate request body
    if (schemas.body) {
      const { error, value } = schemas.body.validate(req.body, {
        abortEarly: false,
        stripUnknown: true,
      });
      
      if (error) {
        return res.status(400).json({
          status: 'error',
          message: 'Invalid request body',
          details: error.details.map(err => ({
            path: err.path.join('.'),
            message: err.message,
          })),
        });
      }
      
      // Replace request body with validated value
      req.body = value;
    }
    
    // Validate query parameters
    if (schemas.query) {
      const { error, value } = schemas.query.validate(req.query, {
        abortEarly: false,
        stripUnknown: true,
      });
      
      if (error) {
        return res.status(400).json({
          status: 'error',
          message: 'Invalid query parameters',
          details: error.details.map(err => ({
            path: err.path.join('.'),
            message: err.message,
          })),
        });
      }
      
      // Replace query with validated value
      req.query = value;
    }
    
    // Validate URL parameters
    if (schemas.params) {
      const { error, value } = schemas.params.validate(req.params, {
        abortEarly: false,
        stripUnknown: true,
      });
      
      if (error) {
        return res.status(400).json({
          status: 'error',
          message: 'Invalid URL parameters',
          details: error.details.map(err => ({
            path: err.path.join('.'),
            message: err.message,
          })),
        });
      }
      
      // Replace params with validated value
      req.params = value;
    }
    
    next();
  };
}

module.exports = { validateRequest };

