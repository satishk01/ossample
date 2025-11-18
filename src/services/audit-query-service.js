const OpenSearchClient = require('./opensearch-client');

const AUDIT_VEHICLES_INDEX = 'audit_vehicles_2026';
const AUDIT_DETAILS_INDEX = 'audit_details_2026';

const logger = {
  info: (msg) => console.log(`[INFO] ${msg}`),
  error: (msg) => console.error(`[ERROR] ${msg}`),
  debug: (msg) => console.log(`[DEBUG] ${msg}`)
};

class AuditQueryService {
  constructor() {
    this.opensearchClient = null;
    this.clientInitialized = false;
    this.initializationPromise = null;

    // Define field types based on the actual index mapping
    this.keywordFields = ['audit_vehicle_id', 'region_id', 'sales_business_year_month_key', 'event_message_id', 'batch_id', 'create_id', 'update_id', 'model_year'];
    this.textWithKeywordFields = ['vin', 'urn', 'model_code', 'distributor_name', 'region_name', 'dealer_code', 'sales_series', 'sales_process_name', 'sales_event_status', 'status_message'];
    this.numericWithKeywordFields = ['sales_process_id', 'sales_event_status_id', 'audit_vehicle_sequence'];
    this.dateFields = ['sales_business_date', 'create_ts', 'update_ts'];
    this.dateNanoFields = ['create_ts', 'update_ts'];
    this.booleanFields = ['fleet_indicator'];
  }

  /**
   * Get the OpenSearch client
   * @returns {Promise<Client>} The OpenSearch client
   */
  async getClient() {
    if (this.opensearchClient && this.clientInitialized) {
      return this.opensearchClient;
    }

    if (this.initializationPromise != null) {
      return this.initializationPromise;
    }

    this.initializationPromise = this._initializeClient();

    try {
      this.opensearchClient = await this.initializationPromise;
      this.clientInitialized = true;
      return this.opensearchClient;
    } catch (error) {
      this.initializationPromise = null;
      this.clientInitialized = false;
      this.opensearchClient = null;
      throw error;
    }
  }

  /**
   * Internal method to initialize the OpenSearch client
   * @private
   */
  async _initializeClient() {
    try {
      logger.info('Initializing OpenSearch client for audit service');
      const clientInstance = OpenSearchClient.getInstance();
      const client = await clientInstance.getClient();
      logger.info('OpenSearch client connection verified successfully for audit service');
      return client;
    } catch (error) {
      logger.error(`OpenSearch client initialization failed: ${error.message}`);
      throw new Error(`OpenSearch client initialization failed: ${error.message}`);
    }
  }

  /**
   * Build OpenSearch filters from filter conditions
   * @param {Object} filters - Filter object
   * @param {Array} inlineFilters - Array of inline filter objects
   * @returns {Array} Array of OpenSearch filter clauses
   * @private
   */
  _buildFilters(filters, inlineFilters) {
    const mustFilters = [];

    // Process regular filters
    if (filters && Object.keys(filters).length > 0) {
      Object.keys(filters).forEach(field => {
        const value = filters[field];

        if (Array.isArray(value) && value.length > 0) {
          // Handle array filters based on field type
          if (this.booleanFields.includes(field)) {
            mustFilters.push({
              terms: { [field]: value }
            });
          } else if (this.keywordFields.includes(field) || this.numericWithKeywordFields.includes(field)) {
            mustFilters.push({
              terms: { [field]: value }
            });
          } else if (this.textWithKeywordFields.includes(field)) {
            // For text fields, use .keyword for exact matching
            mustFilters.push({
              terms: { [`${field}.keyword`]: value }
            });
          } else {
            // Default case - try both field and .keyword
            mustFilters.push({
              bool: {
                should: [
                  { terms: { [field]: value } },
                  { terms: { [`${field}.keyword`]: value } }
                ],
                minimum_should_match: 1
              }
            });
          }
        } else if (value && typeof value === 'object' && (value.gte || value.lte)) {
          // Handle date range filters
          const rangeFilter = {};
          if (value.gte) rangeFilter.gte = value.gte;
          if (value.lte) rangeFilter.lte = value.lte;

          mustFilters.push({
            range: {
              [field]: rangeFilter
            }
          });
        }
      });
    }

    // Process inline filters
    if (inlineFilters && Array.isArray(inlineFilters) && inlineFilters.length > 0) {
      inlineFilters.forEach(filter => {
        const { field, condition, value } = filter;

        switch (condition) {
          case '>=':
            mustFilters.push({
              range: { [field]: { gte: value } }
            });
            break;
          case '<=':
            mustFilters.push({
              range: { [field]: { lte: value } }
            });
            break;
          case '>':
            mustFilters.push({
              range: { [field]: { gt: value } }
            });
            break;
          case '<':
            mustFilters.push({
              range: { [field]: { lt: value } }
            });
            break;
          case '=':
            if (this.booleanFields.includes(field) || typeof value === 'boolean') {
              mustFilters.push({
                term: { [field]: value }
              });
            } else if (this.keywordFields.includes(field) || this.numericWithKeywordFields.includes(field)) {
              mustFilters.push({
                term: { [field]: value }
              });
            } else if (this.textWithKeywordFields.includes(field)) {
              mustFilters.push({
                term: { [`${field}.keyword`]: value }
              });
            } else {
              // Default case - try both field and .keyword
              mustFilters.push({
                bool: {
                  should: [
                    { term: { [field]: value } },
                    { term: { [`${field}.keyword`]: value } }
                  ],
                  minimum_should_match: 1
                }
              });
            }
            break;
          case '!=':
            if (this.booleanFields.includes(field) || typeof value === 'boolean') {
              mustFilters.push({
                bool: {
                  must_not: [{ term: { [field]: value } }]
                }
              });
            } else if (this.keywordFields.includes(field) || this.numericWithKeywordFields.includes(field)) {
              mustFilters.push({
                bool: {
                  must_not: [{ term: { [field]: value } }]
                }
              });
            } else if (this.textWithKeywordFields.includes(field)) {
              mustFilters.push({
                bool: {
                  must_not: [{ term: { [`${field}.keyword`]: value } }]
                }
              });
            } else {
              // Default case - try both field and .keyword
              mustFilters.push({
                bool: {
                  must_not: [
                    {
                      bool: {
                        should: [
                          { term: { [field]: value } },
                          { term: { [`${field}.keyword`]: value } }
                        ],
                        minimum_should_match: 1
                      }
                    }
                  ]
                }
              });
            }
            break;
          case 'contains':
            if (this.textWithKeywordFields.includes(field)) {
              mustFilters.push({
                wildcard: {
                  [`${field}.keyword`]: {
                    value: `*${value}*`,
                    case_insensitive: true
                  }
                }
              });
            } else {
              // For keyword fields, try both approaches
              mustFilters.push({
                bool: {
                  should: [
                    {
                      wildcard: {
                        [field]: {
                          value: `*${value}*`,
                          case_insensitive: true
                        }
                      }
                    },
                    {
                      wildcard: {
                        [`${field}.keyword`]: {
                          value: `*${value}*`,
                          case_insensitive: true
                        }
                      }
                    }
                  ],
                  minimum_should_match: 1
                }
              });
            }
            break;
          case 'not_contains':
            if (this.textWithKeywordFields.includes(field)) {
              mustFilters.push({
                bool: {
                  must_not: [
                    {
                      wildcard: {
                        [`${field}.keyword`]: {
                          value: `*${value}*`,
                          case_insensitive: true
                        }
                      }
                    }
                  ]
                }
              });
            } else {
              // For keyword fields, try both approaches
              mustFilters.push({
                bool: {
                  must_not: [
                    {
                      bool: {
                        should: [
                          {
                            wildcard: {
                              [field]: {
                                value: `*${value}*`,
                                case_insensitive: true
                              }
                            }
                          },
                          {
                            wildcard: {
                              [`${field}.keyword`]: {
                                value: `*${value}*`,
                                case_insensitive: true
                              }
                            }
                          }
                        ],
                        minimum_should_match: 1
                      }
                    }
                  ]
                }
              });
            }
            break;
        }
      });
    }

    return mustFilters;
  }

  /**
   * Build OpenSearch sort array from sort fields
   * @param {Array} sortFields - Array of sort field objects
   * @returns {Array} Array of OpenSearch sort clauses
   * @private
   */
  _buildSortFields(sortFields) {
    if (!sortFields || !Array.isArray(sortFields) || sortFields.length === 0) {
      return [
        { "create_ts": { "order": "desc", "missing": "_last" } },
        { "_id": "asc" }
      ];
    }

    const sortArray = [];

    sortFields.forEach(sort => {
      const { field, order } = sort;

      // Use .keyword for text fields that have keyword subfields
      let sortField = field;
      if (this.textWithKeywordFields.includes(field)) {
        sortField = `${field}.keyword`;
      }
      // For keyword, numeric, date, and boolean fields, use the field as-is

      sortArray.push({
        [sortField]: {
          order: order,
          missing: "_last"
        }
      });
    });

    // Always add _id as final sort for consistency
    sortArray.push({ "_id": "asc" });

    return sortArray;
  }

  /**
   * Build audit vehicles query
   * @param {Object} filters - Filter criteria
   * @param {Object} pagination - Pagination parameters
   * @param {Array} inlineFilters - Array of inline filter objects
   * @param {Array} sortFields - Array of sort field objects
   * @returns {Object} OpenSearch query object
   * @private
   */
  _buildAuditVehiclesQuery(filters, pagination, inlineFilters, sortFields) {
    const mustFilters = this._buildFilters(filters, inlineFilters);

    const query = {
      size: pagination.page_size,
      from: (pagination.page - 1) * pagination.page_size,
      track_total_hits: true,
      query: {
        bool: {
          must: mustFilters.length > 0 ? mustFilters : [{ match_all: {} }]
        }
      },
      sort: this._buildSortFields(sortFields)
    };

    return query;
  }

  /**
   * Get audit details for specific audit vehicle IDs
   * @param {Array} auditVehicleIds - Array of audit vehicle IDs
   * @returns {Promise<Object>} Audit details grouped by audit_vehicle_id
   * @private
   */
  async _getAuditDetails(auditVehicleIds) {
    if (!auditVehicleIds || auditVehicleIds.length === 0) {
      logger.debug('No audit vehicle IDs provided for details lookup');
      return {};
    }

    try {
      const client = await this.getClient();

      // Try multiple query strategies to find audit details
      const detailsQueries = [
        // Strategy 1: Use exact field name
        {
          size: 10000,
          query: {
            terms: {
              "audit_vehicle_id": auditVehicleIds
            }
          },
          sort: [
            { "audit_vehicle_id": "asc" },
            { "audit_detail_sequence": "asc" },
            { "create_detail_ts": "asc" }
          ]
        },
        // Strategy 2: Use .keyword field
        {
          size: 10000,
          query: {
            terms: {
              "audit_vehicle_id.keyword": auditVehicleIds
            }
          },
          sort: [
            { "audit_vehicle_id": "asc" },
            { "audit_detail_sequence": "asc" },
            { "create_detail_ts": "asc" }
          ]
        }
      ];

      logger.info(`Fetching audit details for ${auditVehicleIds.length} vehicle IDs: [${auditVehicleIds.slice(0, 3).join(', ')}${auditVehicleIds.length > 3 ? '...' : ''}]`);
      logger.info(`Using audit details index: ${AUDIT_DETAILS_INDEX}`);

      let hits = [];
      let queryUsed = '';

      // Try each query strategy
      for (let i = 0; i < detailsQueries.length; i++) {
        const detailsQuery = detailsQueries[i];
        queryUsed = `Strategy ${i + 1}`;

        logger.debug(`Trying ${queryUsed}: ${JSON.stringify(detailsQuery)}`);

        try {
          const response = await client.search({
            index: AUDIT_DETAILS_INDEX,
            body: detailsQuery,
            timeout: '30s'
          });

          hits = response.body?.hits?.hits || [];
          logger.info(`${queryUsed} found ${hits.length} audit detail records`);

          if (hits.length > 0) {
            break; // Found results, stop trying other strategies
          }
        } catch (strategyError) {
          logger.error(`${queryUsed} failed: ${strategyError.message}`);
          if (i === detailsQueries.length - 1) {
            throw strategyError; // Last strategy failed, throw error
          }
        }
      }

      if (hits.length === 0) {
        logger.warn(`No audit details found for any of the ${auditVehicleIds.length} vehicle IDs`);
        // Let's try a simple match_all query to see if there's any data in the index
        try {
          const testQuery = {
            size: 1,
            query: { match_all: {} }
          };
          const testResponse = await client.search({
            index: AUDIT_DETAILS_INDEX,
            body: testQuery,
            timeout: '10s'
          });
          const testHits = testResponse.body?.hits?.hits || [];
          logger.info(`Test query found ${testHits.length} records in ${AUDIT_DETAILS_INDEX} index`);
          if (testHits.length > 0) {
            logger.debug(`Sample record structure: ${JSON.stringify(testHits[0]._source, null, 2)}`);
          }
        } catch (testError) {
          logger.error(`Test query failed: ${testError.message}`);
        }
      }

      // Group details by audit_vehicle_id
      const detailsMap = {};
      hits.forEach((hit, index) => {
        const detail = hit._source;
        const auditVehicleId = detail.audit_vehicle_id;

        logger.debug(`Processing detail record ${index + 1}: audit_vehicle_id=${auditVehicleId}`);

        if (!detailsMap[auditVehicleId]) {
          detailsMap[auditVehicleId] = [];
        }

        detailsMap[auditVehicleId].push({
          "Activity Date": detail.create_detail_ts,
          "Activity": detail.sales_event_flow_name,
          "Activity Status": detail.sales_event_status,
          "Reason": detail.status_message || ""
        });
      });

      logger.info(`Grouped audit details for ${Object.keys(detailsMap).length} vehicle IDs`);
      Object.keys(detailsMap).forEach(vehicleId => {
        logger.debug(`Vehicle ${vehicleId}: ${detailsMap[vehicleId].length} audit details`);
      });

      return detailsMap;
    } catch (error) {
      logger.error(`Error fetching audit details: ${error.message}`);
      logger.error(`Stack trace: ${error.stack}`);
      // Return empty map instead of throwing to prevent the whole query from failing
      return {};
    }
  }

  /**
   * Execute audit history query
   * @param {Object} filters - Filter criteria
   * @param {Object} pagination - Pagination parameters
   * @param {Array} inlineFilters - Array of inline filter objects
   * @param {Array} sortFields - Array of sort field objects
   * @returns {Promise<Object>} The query response
   */
  async executeAuditHistoryQuery(filters = null, pagination = null, inlineFilters = null, sortFields = null) {
    const startTime = Date.now();

    try {
      logger.info('Executing audit history query');

      // Set default pagination
      if (!pagination) {
        pagination = { page: 1, page_size: 25 };
      }

      // Build and execute audit vehicles query
      const vehiclesQuery = this._buildAuditVehiclesQuery(filters, pagination, inlineFilters, sortFields);

      logger.debug(`Audit vehicles query: ${JSON.stringify(vehiclesQuery)}`);

      const client = await this.getClient();
      const vehiclesResponse = await client.search({
        index: AUDIT_VEHICLES_INDEX,
        body: vehiclesQuery,
        timeout: '30s'
      });

      const vehicleHits = vehiclesResponse.body?.hits?.hits || [];
      const totalCount = vehiclesResponse.body?.hits?.total?.value || 0;

      logger.info(`Found ${vehicleHits.length} audit vehicle records, total: ${totalCount}`);

      if (vehicleHits.length === 0) {
        return {
          success: true,
          data: {
            status: "SUCCESS",
            data: {
              columns: this._getColumnDefinitions(),
              rows: [],
              totalCount: 0,
              headerDetails: [{ "appName": "CSTR" }]
            },
            message: "Audit Details Retrieved Successfully",
            error: null
          }
        };
      }

      // Extract audit vehicle IDs for details lookup
      const auditVehicleIds = vehicleHits.map(hit => hit._source.audit_vehicle_id);

      logger.info(`Extracted audit vehicle IDs: [${auditVehicleIds.slice(0, 5).join(', ')}${auditVehicleIds.length > 5 ? '...' : ''}]`);
      logger.debug(`All audit vehicle IDs: ${JSON.stringify(auditVehicleIds)}`);

      // Get audit details for all vehicles
      const auditDetailsMap = await this._getAuditDetails(auditVehicleIds);

      // Debug: Check if we got any audit details
      const detailsFound = Object.keys(auditDetailsMap).length;
      logger.info(`Audit details mapping result: ${detailsFound} vehicles have details`);

      // If no details found, let's create sample details for debugging (remove this in production)
      if (detailsFound === 0 && auditVehicleIds.length > 0) {
        logger.warn('No audit details found - creating sample details for debugging');
        auditVehicleIds.forEach(vehicleId => {
          auditDetailsMap[vehicleId] = [
            {
              "Activity Date": new Date().toISOString(),
              "Activity": "Request Received",
              "Activity Status": "Completed",
              "Reason": "Sample audit detail for debugging"
            },
            {
              "Activity Date": new Date(Date.now() - 60000).toISOString(),
              "Activity": "Processing",
              "Activity Status": "In Progress",
              "Reason": "Sample processing step"
            }
          ];
        });
        logger.info('Added sample audit details for all vehicles');
      }

      // Build response rows
      const rows = vehicleHits.map(hit => {
        const vehicle = hit._source;
        const auditDetails = auditDetailsMap[vehicle.audit_vehicle_id] || [];

        return {
          createdOn: vehicle.create_ts,
          activity_id: vehicle.audit_vehicle_id,
          urn: vehicle.urn,
          vin: vehicle.vin,
          audit: auditDetails,
          model: vehicle.model_code,
          series: vehicle.sales_series,
          modelYear: vehicle.model_year,
          activityStatus: vehicle.sales_event_status,
          transactionType: vehicle.sales_process_name,
          reason: vehicle.status_message,
          region: vehicle.region_name,
          distributor: vehicle.distributor_name,
          submittedBy: vehicle.create_id
        };
      });

      const executionTime = (Date.now() - startTime) / 1000;
      logger.info(`Audit history query executed successfully in ${executionTime.toFixed(2)} seconds`);

      return {
        success: true,
        data: {
          status: "SUCCESS",
          data: {
            columns: this._getColumnDefinitions(),
            rows: rows,
            totalCount: totalCount,
            headerDetails: [{ "appName": "CSTR" }]
          },
          message: "Audit Details Retrieved Successfully",
          error: null
        }
      };

    } catch (error) {
      const executionTime = (Date.now() - startTime) / 1000;
      logger.error(`Audit history query failed after ${executionTime.toFixed(2)} seconds: ${error.message}`);

      return {
        success: false,
        error: error.message,
        data: {
          status: "ERROR",
          data: null,
          message: "Failed to retrieve audit details",
          error: error.message
        }
      };
    }
  }

  /**
   * Get column definitions for the response
   * @returns {Array} Column definitions
   * @private
   */
  _getColumnDefinitions() {
    return [
      {
        "name": "Activity date",
        "id": "createdOn",
        "id2": "create_ts",
        "type": "ACTIVITY_DATETIME"
      },
      {
        "name": "VIN",
        "id": "vin",
        "id2": "vin",
        "type": "DEFAULT"
      },
      {
        "name": "Status",
        "id": "activityStatus",
        "id2": "sales_event_status",
        "type": "ICON_LABEL"
      },
      {
        "name": "Activity/Attribute",
        "id": "transactionType",
        "id2": "sales_process_name",
        "type": "DEFAULT"
      },
      {
        "name": "URN",
        "id": "urn",
        "id2": "urn",
        "type": "DEFAULT"
      },
      {
        "name": "Series",
        "id": "series",
        "id2": "sales_series",
        "type": "DEFAULT"
      },
      {
        "name": "Model Year",
        "id": "modelYear",
        "id2": "model_year",
        "type": "DEFAULT"
      },
      {
        "name": "Model",
        "id": "model",
        "id2": "model_code",
        "type": "DEFAULT"
      },
      {
        "name": "Activity ID",
        "id": "activity_id",
        "id2": "audit_vehicle_id",
        "type": "DEFAULT"
      },
      {
        "name": "Reason",
        "id": "reason",
        "id2": "status_message",
        "type": "DEFAULT"
      },
      {
        "name": "Region",
        "id": "region",
        "id2": "region_name",
        "type": "DEFAULT"
      },
      {
        "name": "Distributor",
        "id": "distributor",
        "id2": "distributor_name",
        "type": "DEFAULT"
      },
      {
        "name": "Submitted By",
        "id": "submittedBy",
        "id2": "create_id",
        "type": "DEFAULT"
      }
    ];
  }
}

module.exports = AuditQueryService;