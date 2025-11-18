// Load audit details data from S3 CSV file to OpenSearch index
const AWS = require('aws-sdk');
const csv = require('csv-parser');
const { Readable } = require('stream');
const OpenSearchClient = require('./src/services/opensearch-client');

// Configuration
const S3_BUCKET = 'sks-audit-data';
const CSV_FILE_KEY = 'Audit-details.csv';
const TARGET_INDEX = 'audit_details_2026';
const BATCH_SIZE = 100; // Process records in batches

// Initialize AWS S3
const s3 = new AWS.S3({
  region: process.env.AWS_REGION || 'us-east-1'
});

// Logger
const logger = {
  info: (msg) => console.log(`[INFO] ${new Date().toISOString()} - ${msg}`),
  error: (msg) => console.error(`[ERROR] ${new Date().toISOString()} - ${msg}`),
  warn: (msg) => console.warn(`[WARN] ${new Date().toISOString()} - ${msg}`),
  debug: (msg) => console.log(`[DEBUG] ${new Date().toISOString()} - ${msg}`)
};

class AuditDetailLoader {
  constructor() {
    this.opensearchClient = null;
    this.processedCount = 0;
    this.insertedCount = 0;
    this.updatedCount = 0;
    this.errorCount = 0;
    this.startTime = Date.now();
  }

  /**
   * Initialize OpenSearch client
   */
  async initializeClient() {
    try {
      logger.info('Initializing OpenSearch client...');
      const clientInstance = OpenSearchClient.getInstance();
      this.opensearchClient = await clientInstance.getClient();
      logger.info('OpenSearch client initialized successfully');
    } catch (error) {
      logger.error(`Failed to initialize OpenSearch client: ${error.message}`);
      throw error;
    }
  }

  /**
   * Check if index exists, create if not
   */
  async ensureIndexExists() {
    try {
      logger.info(`Checking if index ${TARGET_INDEX} exists...`);
      
      const indexExists = await this.opensearchClient.indices.exists({
        index: TARGET_INDEX
      });

      if (!indexExists.body) {
        logger.info(`Index ${TARGET_INDEX} does not exist, creating...`);
        
        // Create index with mapping based on audit details schema
        const indexMapping = {
          settings: {
            index: {
              number_of_shards: 3,
              number_of_replicas: 1,
              codec: 'best_compression',
              refresh_interval: '30s',
              max_result_window: 5000000
            }
          },
          mappings: {
            properties: {
              audit_detail_id: { type: 'keyword' },
              audit_vehicle_id: { type: 'keyword' },
              sales_event_flow_id: {
                type: 'long',
                fields: { keyword: { type: 'keyword' } }
              },
              sales_event_flow_name: {
                type: 'text',
                fields: { keyword: { type: 'keyword' } }
              },
              sales_event_status_id: {
                type: 'long',
                fields: { keyword: { type: 'keyword' } }
              },
              sales_event_status: {
                type: 'text',
                fields: { keyword: { type: 'keyword' } }
              },
              status_message: {
                type: 'text',
                fields: { keyword: { type: 'keyword' } }
              },
              inbound: {
                type: 'object',
                enabled: true,
                properties: {
                  nested_keyword: { type: 'keyword' }
                }
              },
              outbound: {
                type: 'object',
                enabled: true,
                properties: {
                  nested_keyword: { type: 'keyword' }
                }
              },
              event_flow_ts: {
                type: 'date_nanos',
                fields: { keyword: { type: 'keyword' } }
              },
              audit_detail_sequence: {
                type: 'integer',
                fields: { keyword: { type: 'keyword' } }
              },
              create_detail_id: { type: 'keyword' },
              create_detail_ts: {
                type: 'date_nanos',
                fields: { keyword: { type: 'keyword' } }
              },
              update_detail_id: { type: 'keyword' },
              update_detail_ts: {
                type: 'date_nanos',
                fields: { keyword: { type: 'keyword' } }
              }
            }
          }
        };

        await this.opensearchClient.indices.create({
          index: TARGET_INDEX,
          body: indexMapping
        });

        logger.info(`Index ${TARGET_INDEX} created successfully`);
      } else {
        logger.info(`Index ${TARGET_INDEX} already exists`);
      }
    } catch (error) {
      logger.error(`Error ensuring index exists: ${error.message}`);
      throw error;
    }
  }

  /**
   * Download and parse CSV file from S3
   */
  async downloadAndParseCSV() {
    return new Promise((resolve, reject) => {
      logger.info(`Downloading CSV file from S3: s3://${S3_BUCKET}/${CSV_FILE_KEY}`);
      
      const records = [];
      let rowCount = 0;

      const s3Stream = s3.getObject({
        Bucket: S3_BUCKET,
        Key: CSV_FILE_KEY
      }).createReadStream();

      s3Stream
        .pipe(csv({
          // Handle different CSV formats
          skipEmptyLines: true,
          trim: true
        }))
        .on('data', (row) => {
          rowCount++;
          
          // Transform and validate the row data
          const transformedRow = this.transformCSVRow(row, rowCount);
          if (transformedRow) {
            records.push(transformedRow);
          }
          
          // Log progress every 1000 rows
          if (rowCount % 1000 === 0) {
            logger.info(`Parsed ${rowCount} rows from CSV...`);
          }
        })
        .on('end', () => {
          logger.info(`CSV parsing completed. Total rows: ${rowCount}, Valid records: ${records.length}`);
          resolve(records);
        })
        .on('error', (error) => {
          logger.error(`Error parsing CSV: ${error.message}`);
          reject(error);
        });
    });
  }

  /**
   * Transform CSV row to match OpenSearch document format
   */
  transformCSVRow(row, rowNumber) {
    try {
      // Handle different possible CSV column names (case insensitive)
      const getColumnValue = (possibleNames) => {
        for (const name of possibleNames) {
          const value = row[name] || row[name.toLowerCase()] || row[name.toUpperCase()];
          if (value !== undefined && value !== null && value !== '') {
            return value.trim();
          }
        }
        return null;
      };

      const auditDetailId = getColumnValue(['audit_detail_id', 'auditDetailId', 'AUDIT_DETAIL_ID']);
      const auditVehicleId = getColumnValue(['audit_vehicle_id', 'auditVehicleId', 'AUDIT_VEHICLE_ID']);
      
      if (!auditDetailId) {
        logger.warn(`Row ${rowNumber}: Missing audit_detail_id, skipping`);
        return null;
      }

      if (!auditVehicleId) {
        logger.warn(`Row ${rowNumber}: Missing audit_vehicle_id, skipping`);
        return null;
      }

      // Transform the row data
      const document = {
        audit_detail_id: auditDetailId,
        audit_vehicle_id: auditVehicleId,
        sales_event_flow_id: this.parseNumber(getColumnValue(['sales_event_flow_id', 'salesEventFlowId', 'SALES_EVENT_FLOW_ID'])),
        sales_event_flow_name: getColumnValue(['sales_event_flow_name', 'salesEventFlowName', 'SALES_EVENT_FLOW_NAME']),
        sales_event_status_id: this.parseNumber(getColumnValue(['sales_event_status_id', 'salesEventStatusId', 'SALES_EVENT_STATUS_ID'])),
        sales_event_status: getColumnValue(['sales_event_status', 'salesEventStatus', 'SALES_EVENT_STATUS']),
        status_message: getColumnValue(['status_message', 'statusMessage', 'STATUS_MESSAGE']),
        inbound: this.parseJSON(getColumnValue(['inbound', 'INBOUND'])),
        outbound: this.parseJSON(getColumnValue(['outbound', 'OUTBOUND'])),
        event_flow_ts: this.parseDateTime(getColumnValue(['event_flow_ts', 'eventFlowTs', 'EVENT_FLOW_TS'])),
        audit_detail_sequence: this.parseNumber(getColumnValue(['audit_detail_sequence', 'auditDetailSequence', 'AUDIT_DETAIL_SEQUENCE'])),
        create_detail_id: getColumnValue(['create_detail_id', 'createDetailId', 'CREATE_DETAIL_ID']),
        create_detail_ts: this.parseDateTime(getColumnValue(['create_detail_ts', 'createDetailTs', 'CREATE_DETAIL_TS'])),
        update_detail_id: getColumnValue(['update_detail_id', 'updateDetailId', 'UPDATE_DETAIL_ID']),
        update_detail_ts: this.parseDateTime(getColumnValue(['update_detail_ts', 'updateDetailTs', 'UPDATE_DETAIL_TS']))
      };

      return document;
    } catch (error) {
      logger.error(`Error transforming row ${rowNumber}: ${error.message}`);
      return null;
    }
  }

  /**
   * Parse number values from CSV
   */
  parseNumber(value) {
    if (!value || value === '') return null;
    const parsed = parseInt(value, 10);
    return isNaN(parsed) ? null : parsed;
  }

  /**
   * Parse datetime values from CSV
   */
  parseDateTime(value) {
    if (!value || value === '') return null;
    try {
      const date = new Date(value);
      return isNaN(date.getTime()) ? null : date.toISOString();
    } catch (error) {
      return null;
    }
  }

  /**
   * Parse JSON values from CSV (for inbound/outbound fields)
   */
  parseJSON(value) {
    if (!value || value === '') return null;
    try {
      // If it's already an object, return as is
      if (typeof value === 'object') return value;
      
      // Try to parse as JSON string
      return JSON.parse(value);
    } catch (error) {
      // If JSON parsing fails, create a simple object with the value
      return { nested_keyword: value };
    }
  }

  /**
   * Check if document exists in OpenSearch
   */
  async documentExists(auditDetailId) {
    try {
      const response = await this.opensearchClient.exists({
        index: TARGET_INDEX,
        id: auditDetailId
      });
      return response.body;
    } catch (error) {
      // Document doesn't exist
      return false;
    }
  }

  /**
   * Process records in batches
   */
  async processRecords(records) {
    logger.info(`Processing ${records.length} records in batches of ${BATCH_SIZE}...`);

    for (let i = 0; i < records.length; i += BATCH_SIZE) {
      const batch = records.slice(i, i + BATCH_SIZE);
      await this.processBatch(batch, i);
      
      // Log progress
      const processed = Math.min(i + BATCH_SIZE, records.length);
      logger.info(`Processed ${processed}/${records.length} records (${Math.round(processed/records.length*100)}%)`);
    }
  }

  /**
   * Process a batch of records
   */
  async processBatch(batch, batchStartIndex) {
    const bulkOperations = [];

    for (const record of batch) {
      try {
        const exists = await this.documentExists(record.audit_detail_id);
        
        if (exists) {
          // Delete and insert (update)
          bulkOperations.push({
            delete: {
              _index: TARGET_INDEX,
              _id: record.audit_detail_id
            }
          });
          bulkOperations.push({
            index: {
              _index: TARGET_INDEX,
              _id: record.audit_detail_id
            }
          });
          bulkOperations.push(record);
          this.updatedCount++;
        } else {
          // Insert new record
          bulkOperations.push({
            index: {
              _index: TARGET_INDEX,
              _id: record.audit_detail_id
            }
          });
          bulkOperations.push(record);
          this.insertedCount++;
        }

        this.processedCount++;
      } catch (error) {
        logger.error(`Error processing record ${record.audit_detail_id}: ${error.message}`);
        this.errorCount++;
      }
    }

    // Execute bulk operations
    if (bulkOperations.length > 0) {
      try {
        const response = await this.opensearchClient.bulk({
          body: bulkOperations,
          timeout: '60s'
        });

        // Check for bulk operation errors
        if (response.body.errors) {
          const errors = response.body.items.filter(item => 
            item.index?.error || item.delete?.error
          );
          logger.error(`Bulk operation had ${errors.length} errors`);
          errors.forEach(error => {
            logger.error(`Bulk error: ${JSON.stringify(error)}`);
          });
          this.errorCount += errors.length;
        }
      } catch (error) {
        logger.error(`Bulk operation failed: ${error.message}`);
        this.errorCount += batch.length;
      }
    }
  }

  /**
   * Print final statistics
   */
  printStatistics() {
    const duration = (Date.now() - this.startTime) / 1000;
    logger.info('='.repeat(60));
    logger.info('AUDIT DETAILS LOAD OPERATION COMPLETED');
    logger.info('='.repeat(60));
    logger.info(`Total processed: ${this.processedCount}`);
    logger.info(`Inserted: ${this.insertedCount}`);
    logger.info(`Updated: ${this.updatedCount}`);
    logger.info(`Errors: ${this.errorCount}`);
    logger.info(`Duration: ${duration.toFixed(2)} seconds`);
    logger.info(`Rate: ${(this.processedCount / duration).toFixed(2)} records/second`);
    logger.info('='.repeat(60));
  }

  /**
   * Main execution method
   */
  async execute() {
    try {
      logger.info('Starting audit details data load process...');
      
      // Initialize OpenSearch client
      await this.initializeClient();
      
      // Ensure index exists
      await this.ensureIndexExists();
      
      // Download and parse CSV
      const records = await this.downloadAndParseCSV();
      
      if (records.length === 0) {
        logger.warn('No valid records found in CSV file');
        return;
      }
      
      // Process records
      await this.processRecords(records);
      
      // Print statistics
      this.printStatistics();
      
      logger.info('Audit details data load completed successfully');
      
    } catch (error) {
      logger.error(`Load process failed: ${error.message}`);
      logger.error(`Stack trace: ${error.stack}`);
      process.exit(1);
    }
  }
}

// Execute the loader
if (require.main === module) {
  const loader = new AuditDetailLoader();
  loader.execute().catch(error => {
    console.error('Fatal error:', error);
    process.exit(1);
  });
}

module.exports = AuditDetailLoader;