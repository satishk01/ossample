// config/settings.js
require('dotenv').config();

/**
 * Application settings class that loads configuration from environment variables
 * with sensible defaults
 */
class Settings {
  constructor() {
    // AWS configuration
    this.awsRegion = process.env.AWS_REGION || 'us-east-1';

    // OpenSearch configuration
    this.opensearchHost = process.env.OPENSEARCH_HOST || 'ni781z5waaje6y4co7w0.us-east-1.aoss.amazonaws.com';
    this.opensearchPort = parseInt(process.env.OPENSEARCH_PORT || '9200', 10);
    this.opensearchUseSSL = process.env.OPENSEARCH_USE_SSL === 'true';
    this.opensearchVerifyCerts = process.env.OPENSEARCH_VERIFY_CERTS === 'true';
    this.opensearchUsername = process.env.OPENSEARCH_USERNAME || null;
    this.opensearchPassword = process.env.OPENSEARCH_PASSWORD || null;
    this.opensearchTimeout = parseInt(process.env.OPENSEARCH_TIMEOUT || '300', 10);


    // Index configuration
    this.collectionName = process.env.COLLECTION_NAME || 'audit-demo';
    this.yearlyIndexPrefix = process.env.YEARLY_INDEX_PREFIX || 'pip-inventory';
    this.indexNames = process.env.INDEX_NAMES || '["pip-inventory-2022"]';

    // API configuration
    this.apiTitle = process.env.API_TITLE || 'PIP Data API';
    this.apiVersion = process.env.API_VERSION || '1.0.0';
    this.logLevel = process.env.LOG_LEVEL || 'INFO';
    this.corsOrigins = process.env.CORS_ORIGINS || '["*"]';
  }

  /**
   * Parse index_names JSON string to array
   */
  get indexNamesList() {
    try {
      return JSON.parse(this.indexNames);
    } catch (error) {
      return ['pip-inventory-2022']; // fallback
    }
  }

  /**
   * Parse cors_origins JSON string to array
   */
  get corsOriginsList() {
    try {
      return JSON.parse(this.corsOrigins);
    } catch (error) {
      return ['*']; // fallback
    }
  }
}

// Create and export a singleton instance
const settings = new Settings();
module.exports = settings;

