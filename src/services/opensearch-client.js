// services/opensearch-client.js
const AWS = require('aws-sdk');
const { Client } = require('@opensearch-project/opensearch');
const { AwsSigv4Signer } = require('@opensearch-project/opensearch/aws');
const settings = require('../config/settings');

const logger = {
  info: (msg) => console.log(`[INFO] ${msg}`),
  error: (msg) => console.error(`[ERROR] ${msg}`)
};

/**
 * Singleton OpenSearch client manager
 */
class OpenSearchClient {
  static _instance;
  _client = null;
  _collectionEndpoint = null;
  
  /**
   * Get the singleton instance
   */
  static getInstance() {
    if (!OpenSearchClient._instance) {
      OpenSearchClient._instance = new OpenSearchClient();
    }
    return OpenSearchClient._instance;
  }
  
  constructor() {
    if (OpenSearchClient._instance) {
      return OpenSearchClient._instance;
    }
    OpenSearchClient._instance = this;
  }
  
  /**
   * Get the collection endpoint from AWS
   * @returns {Promise<string>} The collection endpoint
   */
  async _getCollectionEndpoint() {
    try {
      const aossClient = new AWS.OpenSearchServerless({ 
        region: settings.awsRegion
      });
      
      logger.info(`Getting collection details for '${settings.collectionName}'...`);
      
      const response = await aossClient.batchGetCollection({
        names: [settings.collectionName]
      }).promise();
      
      const collections = response.collectionDetails || [];
      
      if (!collections.length) {
        throw new Error(`Collection '${settings.collectionName}' not found`);
      }
      
      const collection = collections[0];
      const status = collection.status;
      
      if (status !== 'ACTIVE') {
        throw new Error(`Collection '${settings.collectionName}' is not active. Status: ${status}`);
      }
      
      let collectionEndpoint = collection.collectionEndpoint;
      if (!collectionEndpoint) {
        throw new Error(`No endpoint found for collection '${settings.collectionName}'`);
      }
      
      // Remove protocol if present
      if (collectionEndpoint.startsWith('https://')) {
        collectionEndpoint = collectionEndpoint.substring(8);
      } else if (collectionEndpoint.startsWith('http://')) {
        collectionEndpoint = collectionEndpoint.substring(7);
      }
      
      logger.info(`Collection endpoint: ${collectionEndpoint}`);
      this._collectionEndpoint = collectionEndpoint;
      return collectionEndpoint;
    } catch (error) {
      logger.error(`Failed to get collection endpoint: ${error.message}`);
      throw error;
    }
  }
  
  /**
   * Initialize OpenSearch Serverless client
   * @returns {Promise<void>}
   */
  async _initializeClient() {
    try {
      const endpoint = await this._getCollectionEndpoint();
      
      // Create the client with AWS Sigv4 authentication
      this._client = new Client({
        node: `https://${endpoint}:443`,
        ...AwsSigv4Signer({
          region: settings.awsRegion,
          service: 'aoss'
          // No getCredentials needed - will use instance role credentials automatically
        }),
        ssl: { 
          rejectUnauthorized: true
        },
        requestTimeout: settings.opensearchTimeout * 1000, // convert to ms
        maxRetries: 3
      });
      
      logger.info('OpenSearch client initialized successfully');
    } catch (error) {
      logger.error(`Failed to initialize OpenSearch client: ${error.message}`);
      throw error;
    }
  }
  
  /**
   * Get the OpenSearch client instance
   * @returns {Promise<Client>} The OpenSearch client
   */
  async getClient() {
    if (!this._client) {
      await this._initializeClient();
    }
    return this._client;
  }
  
  /**
   * Get the collection endpoint
   * @returns {string|null} The collection endpoint
   */
  get endpoint() {
    return this._collectionEndpoint;
  }
}

module.exports = OpenSearchClient;

