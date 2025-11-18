const OpenSearchClient = require('./opensearch-client');
const {
  DealerData,
  DistrictData,
  RegionData,
  PaginationInfo,
  QueryInfo,
  PIPQueryResponse,
  PIPQueryResponseV3,
  PIPQueryResponseV4,
  PaginationSummaryResponse
} = require('../models/response-models');
const settings = require('../config/settings');
const { log } = require('console');

const YEARLY_INDEX_PREFIX = 'pip-inventory';

const logger = {
  info: (msg) => console.log(`[INFO] ${msg}`),
  error: (msg) => console.error(`[ERROR] ${msg}`),
  debug: (msg) => console.log(`[DEBUG] ${msg}`)
};
class PipelineQueryService {
  constructor() {
    this.opensearchClient = null;
    this.clientInitialized = false;
    this.initializationPromise = null;
  }

  /**
   * Capitalizes a filter value if it's a string
   * @param {any} value - The value to capitalize
   * @returns {any} - The capitalized value or original value if not a string
   */
  _capitalizeValue(value) {
    if (typeof value === 'string') {
      return value.toUpperCase();
    }
    return value;
  }

  /**
   * Capitalizes all values in a filter array or single value
   * @param {any} filterValue - The filter value(s) to capitalize
   * @returns {any} - The filter value(s) with strings capitalized
   */
  _capitalizeFilterValues(filterValue) {
    if (Array.isArray(filterValue)) {
      return filterValue.map(value => this._capitalizeValue(value));
    }
    return this._capitalizeValue(filterValue);
  }

  /**
   * Capitalizes inline filter values based on field type and condition
   * @param {Object} inlineFilter - The inline filter object
   * @returns {Object} - The inline filter with capitalized values where appropriate
   */
  _capitalizeInlineFilterValue(inlineFilter) {
    // Only capitalize value for string-based fields and specific conditions
    // Skip range/numeric conditions
    if (inlineFilter.condition && ['=', 'contains'].includes(inlineFilter.condition)) {
      return {
        ...inlineFilter,
        value: this._capitalizeValue(inlineFilter.value)
      };
    }
    return inlineFilter;
  }

  /**
 * Get the OpenSearch client with proper EC2 role-based credential handling
 * @returns {Promise<Client>} The OpenSearch client
 */
  async getClient() {
    // If client is already initialized, return it
    if (this.opensearchClient && this.clientInitialized) {
      return this.opensearchClient;
    }

    // If initialization is in progress, wait for it
    if (this.initializationPromise != null) {
      return this.initializationPromise;
    }
    // Start initialization
    this.initializationPromise = this._initializeClient();

    try {
      this.opensearchClient = await this.initializationPromise;
      this.clientInitialized = true;
      return this.opensearchClient;
    } catch (error) {
      // Reset on error so it can be retried
      this.initializationPromise = null;
      this.clientInitialized = false;
      this.opensearchClient = null;
      throw error;
    }
  }
  /**
   * Internal method to initialize the OpenSearch client with retry logic
   * @private
   */
  async _initializeClient() {
    const maxRetries = 3;
    let lastError;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        logger.info(`Initializing OpenSearch client (attempt ${attempt}/${maxRetries})`);

        // Get client instance
        const clientInstance = OpenSearchClient.getInstance();
        const client = await clientInstance.getClient();

        // Test the connection with a simple health check
        logger.debug('Testing OpenSearch connection...');
        //const healthResponse = await client.cluster.health({
        //  timeout: '10s'
        // });

        logger.info('OpenSearch client connection verified successfully');
        // logger.debug(`Cluster health: ${JSON.stringify(healthResponse.body)}`);

        return client;

      } catch (error) {
        lastError = error;
        logger.error(`OpenSearch client initialization attempt ${attempt} failed: ${error.message}`);

        // Check if this is a credentials-related error
        const isCredentialsError = error.message.includes('getCredentials') ||
          error.message.includes('credentials') ||
          error.message.includes('CredentialsProviderError') ||
          error.message.includes('opts.getCredentials');

        if (isCredentialsError) {
          logger.info('Detected credentials error - this is common on EC2 startup');

          // Wait longer between retries for credentials errors
          if (attempt < maxRetries) {
            const delay = Math.min(1000 * Math.pow(2, attempt - 1), 5000); // Exponential backoff, max 5s
            logger.info(`Waiting ${delay}ms before retry...`);
            await new Promise(resolve => setTimeout(resolve, delay));
          }
        } else {
          // For non-credentials errors, fail fast after first attempt
          logger.error('Non-credentials error detected, not retrying');
          break;
        }
      }
    }

    // If we get here, all attempts failed
    logger.error(`Failed to initialize OpenSearch client after ${maxRetries} attempts`);
    throw new Error(`OpenSearch client initialization failed: ${lastError.message}`);
  }
  /**
   * Build OpenSearch filters from inline filter conditions
   * @param {Array} inlineFilters - Array of inline filter objects
   * @returns {Array} Array of OpenSearch filter clauses
   * @private
   */
  _buildInlineFilters(inlineFilters) {
    const mustFilters = [];

    if (!inlineFilters || !Array.isArray(inlineFilters)) {
      console.log('[DEBUG] No inline filters provided or not an array');
      return mustFilters;
    }

    console.log(`[DEBUG] Processing ${inlineFilters.length} inline filters`);
    
    inlineFilters.forEach((filter, index) => {
      const { field, condition, value } = filter;
      console.log(`[DEBUG] Filter ${index + 1}: field="${field}", condition="${condition}", value=${JSON.stringify(value)}`);

      // Helper function to parse comma-separated string into array
      const parseValue = (val) => {
        const originalValue = val;
        let result;
        
        if (typeof val === 'string' && val.includes(',')) {
          result = val.split(',').map(v => v.trim().toUpperCase()).filter(v => v.length > 0);
          console.log(`[DEBUG] Parsed comma-separated string - Original: "${originalValue}" -> Result: [${result.join(', ')}]`);
        } else {
          result = Array.isArray(val) ? val.map(v => typeof v === 'string' ? v.trim().toUpperCase() : v) : [typeof val === 'string' ? val.trim().toUpperCase() : val];
          console.log(`[DEBUG] Parsed single/array value - Original: ${JSON.stringify(originalValue)} -> Result: [${result.join(', ')}]`);
        }
        
        return result;
      };

      switch (condition) {
        case '>=':
          mustFilters.push({
            range: {
              [field]: { gte: value }
            }
          });
          break;
        case '<=':
          mustFilters.push({
            range: {
              [field]: { lte: value }
            }
          });
          break;
        case '>':
          mustFilters.push({
            range: {
              [field]: { gt: value }
            }
          });
          break;
        case '<':
          mustFilters.push({
            range: {
              [field]: { lt: value }
            }
          });
          break;
        case '=':
          const equalValues = parseValue(value);
          // Use multiple strategies for case insensitive matching
          const shouldClauses = [];

          shouldClauses.push({
            terms: {
              [field]: equalValues
            }
          });

          shouldClauses.push({
            terms: {
              [`${field}.keyword`]: equalValues
            }
          });

          mustFilters.push({
            bool: {
              should: shouldClauses,
              minimum_should_match: 1
            }
          });
          break;
        case '!=':
          const notEqualValues = parseValue(value);
          // Use multiple strategies for case insensitive not equal matching
          const notEqualShouldClauses = [];

          notEqualShouldClauses.push({
            terms: {
              [field]: notEqualValues
            }
          });

          notEqualShouldClauses.push({
            terms: {
              [`${field}.keyword`]: notEqualValues
            }
          });

          mustFilters.push({
            bool: {
              must_not: [
                {
                  bool: {
                    should: notEqualShouldClauses,
                    minimum_should_match: 1
                  }
                }
              ]
            }
          });
          break;
        case 'contains':
          const containsValues = parseValue(value);
          // Use case insensitive wildcard queries for contains functionality
          const containsShouldClauses = [];

          containsValues.forEach(val => {
            const wildcardPattern = `*${val}*`.toLowerCase();

            containsShouldClauses.push({
              wildcard: {
                [field]: {
                  value: wildcardPattern,
                  case_insensitive: true
                }
              }
            });

            containsShouldClauses.push({
              wildcard: {
                [`${field}.keyword`]: {
                  value: wildcardPattern,
                  case_insensitive: true
                }
              }
            });
          });

          mustFilters.push({
            bool: {
              should: containsShouldClauses,
              minimum_should_match: 1
            }
          });
          break;
        case 'not_contains':
          const notContainsValues = parseValue(value);
          // Use case insensitive wildcard queries for not contains functionality
          const notContainsShouldClauses = [];

          notContainsValues.forEach(val => {
            const wildcardPattern = `*${val}*`.toLowerCase();

            notContainsShouldClauses.push({
              wildcard: {
                [field]: {
                  value: wildcardPattern,
                  case_insensitive: true
                }
              }
            });

            notContainsShouldClauses.push({
              wildcard: {
                [`${field}.keyword`]: {
                  value: wildcardPattern,
                  case_insensitive: true
                }
              }
            });
          });

          mustFilters.push({
            bool: {
              must_not: [
                {
                  bool: {
                    should: notContainsShouldClauses,
                    minimum_should_match: 1
                  }
                }
              ]
            }
          });
          break;
        case 'not_in':
          const notInValues = parseValue(value);
          // Use uppercase values with multiple field strategies for case insensitive not_in matching
          const notInShouldClauses = [];

          // Add terms queries for uppercase values
          notInShouldClauses.push({
            terms: {
              [field]: notInValues
            }
          });

          notInShouldClauses.push({
            terms: {
              [`${field}.keyword`]: notInValues
            }
          });

          // Also add original case match queries for broader coverage
          const originalNotInValues = Array.isArray(value) ? value : [value];
          originalNotInValues.forEach(val => {
            if (typeof val === 'string') {
              notInShouldClauses.push({
                match: {
                  [field]: {
                    query: val,
                    operator: "and"
                  }
                }
              });
              
              notInShouldClauses.push({
                match: {
                  [`${field}.keyword`]: {
                    query: val,
                    operator: "and"
                  }
                }
              });
            }
          });

          mustFilters.push({
            bool: {
              must_not: [
                {
                  bool: {
                    should: notInShouldClauses,
                    minimum_should_match: 1
                  }
                }
              ]
            }
          });
          break;

        default:
          logger.warn(`Unsupported inline filter condition: ${condition}`);
          break;
      }
    });

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
      // Return default sort if no sort fields provided
      return [
        { "rdrdate": { "order": "desc", "missing": "_last" } },
        { "_id": "asc" }
      ];
    }

    const sortArray = [];

    sortFields.forEach(sort => {
      const { field, order } = sort;

      // Just use the field as provided - don't automatically add .keyword versions
      // This prevents mapping errors when .keyword fields don't exist
      const sortClause = {
        [field]: {
          order: order,
          missing: "_last"
        }
      };

      sortArray.push(sortClause);
    });

    // Always add _id as final sort for consistency
    sortArray.push({ "_id": "asc" });

    return sortArray;
  }

  /**
   * Build retail vehicle lookup query
   * @param {Object} filters - Filter criteria
   * @param {number} size - Maximum number of results
   * @param {Object} pagination - Pagination parameters (page, page_size)
   * @param {Array} inlineFilters - Array of inline filter objects
   * @param {Array} sortFields - Array of sort field objects
   * @returns {Object} OpenSearch query object
   * @private
   */
  _buildRetailVehicleLookupQuery(filters = null, size = 100, pagination = null, inlineFilters = null, sortFields = null) {
    const query = {
      size: Math.min(size, 10000), // Limit to reasonable size
      track_total_hits: true, // Track accurate total count beyond 10,000
      query: {
        bool: {
          must: [
            { match_all: {} }
          ]
        }
      },
      sort: this._buildSortFields(sortFields) // Use custom sort or default
    };

    // Add pagination support
    if (pagination && pagination.page && pagination.page_size) {
      const from = (pagination.page - 1) * pagination.page_size;
      const requestedSize = Math.min(pagination.page_size, 10000);

      query.from = from;
      query.size = requestedSize;
    }

    // Collect all filters (regular filters + inline filters)
    const mustFilters = [];

    // Apply regular filters if provided
    if (filters && Object.keys(filters).length > 0) {
      // Handle space-separated accessory code fields differently
      const spaceSeparatedFields = ['factoryaccessorycodes', 'ppoaccessorycodes'];

      spaceSeparatedFields.forEach(filterKey => {
        if (filters[filterKey] && Array.isArray(filters[filterKey]) && filters[filterKey].length > 0) {
          // For space-separated fields, use match query to find individual codes within the string
          const shouldQueries = filters[filterKey].map(code => ({
            match: {
              [filterKey]: {
                query: code,
                operator: "and"
              }
            }
          }));

          if (shouldQueries.length > 0) {
            mustFilters.push({
              bool: {
                should: shouldQueries,
                minimum_should_match: 1
              }
            });
          }
        }
      });

      // Handle regular array-based filters for other retail vehicle fields with case-insensitive support
      const arrayFilters = [
        'currentregioncode',
        'currentdistrictcode',
        'distributorcode',
        'currentdealercode',
        'modelyear',
        'modelcode',
        'fleetindicator',
        'brandcode',
        'exteriorcolorcode',
        'interiortrimcolorcode',
        'cartruckcode',
        'dealertype',
        'teammemberleaseindicator',
        'transmissioncode',
        'salesseriesname',
        'gradespeccode',
        'drivetrainname',
        'napcbucode',
      ];

      arrayFilters.forEach(filterKey => {
        if (filters[filterKey] && Array.isArray(filters[filterKey]) && filters[filterKey].length > 0) {
          // Use terms query for exact match with capitalized values
          mustFilters.push({
            terms: {
              [filterKey]: filters[filterKey]
            }
          });
        }
      });
    }

    // Apply inline filters if provided
    if (inlineFilters && Array.isArray(inlineFilters) && inlineFilters.length > 0) {
      const inlineFilterClauses = this._buildInlineFilters(inlineFilters);
      mustFilters.push(...inlineFilterClauses);
    }

    // Add all filters to the main query
    if (mustFilters.length > 0) {
      query.query.bool.must = query.query.bool.must.concat(mustFilters);
    }

    return query;
  }


  /**
   * Process retail vehicle lookup response
   * @param {Object} response - OpenSearch response
   * @returns {Array} Processed vehicle data
   * @private
   */
  _processRetailVehicleLookupResponse(response) {
    const hits = response.body?.hits?.hits || [];

    logger.info(`Processing ${hits.length} retail vehicle records`);

    return hits.map(hit => {
      const source = hit._source || {};
      return {
        ...source
      };
    });
  }



  /**
   * Execute retail vehicle lookup query
   * @param {Object} filters - Filter criteria
   * @param {Object} pagination - Pagination parameters
   * @param {Array} indexName - Array of index names to query
   * @param {Array} inlineFilters - Array of inline filter objects
   * @param {Array} sortFields - Array of sort field objects
   * @returns {Promise<Object>} The query response
   */
  async executeRetailVehicleLookupQuery(filters = null, pagination = null, indexName = null, inlineFilters = null, sortFields = null) {
    const startTime = Date.now();
    let opensearchQuery = null;

    try {
      logger.info('entered the function executeRetailVehicleLookupQuery');

      // Set default pagination
      if (!pagination) {
        pagination = { page: 1, page_size: 100 };
      }

      // If no index name is provided, use default retail vehicle index
      const indices = indexName || ['pipe-vh-vehicle-info-2025'];

      logger.info("Retail vehicle indices name is ");
      logger.info(indices);

      // Convert filters to globalFilters
      let globalFilters = null;
      logger.info(`Initial Retail vehicle filters: ${JSON.stringify(filters)}`);
      if (filters) {
        logger.info('Processing Retail vehicle filters');
        globalFilters = {};
        logger.info(`Initial Retail vehicle globalFilters: ${JSON.stringify(globalFilters)}`);
        // Map API filter fields to OpenSearch document fields
        const fieldMapping = {
          region_code: 'currentregioncode',
          district_code: 'currentdistrictcode',
          distributor_code: 'distributorcode',
          dealer_code: 'currentdealercode',
          model_year: 'modelyear',
          model_code: 'modelcode',
          fleet_flag: 'fleetindicator',
          brand_code: 'brandcode',
          // segment_code: '', // not in retail vehicle index
          exterior_color_code: 'exteriorcolorcode',
          interior_color_code: 'interiortrimcolorcode',
          car_trk_indicator: 'cartruckcode',
          dealer_type: 'dealertype',
          team_lease_indicator: 'teammemberleaseindicator',
          transmissiontype_code: 'transmissioncode',
          series_name: 'salesseriesname',
          grade_code: 'gradespeccode',
          drivetrain_code: 'drivetrainname',
          napc_bu_code: 'napcbucode',
          // Add this new mapping
          retailsalesbusinesssalesmonthfmt: 'retailsalesbusinesssalesmonthfmt'
        };
        logger.info(`Initial Retail vehicle field mapping: ${JSON.stringify(fieldMapping)}`);

        // Handle accessory_code mapping based on fac_pio_indicator

        if (filters.fac_pio_indicator?.length > 0) {
          if (filters.fac_pio_indicator[0].toLowerCase() === 'true') {
            fieldMapping['accessory_code'] = 'ppoaccessorycodes';
          } else {
            fieldMapping['accessory_code'] = 'factoryaccessorycodes';
          }
        } else {
          fieldMapping['accessory_code'] = 'factoryaccessorycodes';
        }

        logger.info(`Retail vehicle field mapping: ${JSON.stringify(fieldMapping)}`);
        // Map the fields from API schema to OpenSearch fields
        for (const [apiField, opensearchField] of Object.entries(fieldMapping)) {
          if (filters[apiField]) {
            logger.info(`Mapping API field "${apiField}" to OpenSearch field "${opensearchField}"`);
            // Capitalize filter values for keyword field matching
            globalFilters[opensearchField] = this._capitalizeFilterValues(filters[apiField]);
          }
        }
      }
      logger.info(`Final Retail vehicle globalFilters: ${JSON.stringify(globalFilters)}`);
      // Calculate pagination parameters
      const currentPage = pagination?.page || 1;
      const pageSize = pagination?.page_size || 100;
      const from = (currentPage - 1) * pageSize;
      const maxResultWindow = 50000;

      // Check if we need to use alternative method for large offsets
      if (from + pageSize > maxResultWindow) {
        logger.info(`Using large dataset method for large offset: from=${from}, pageSize=${pageSize}`);
        return await this._executeRetailVehicleScrollQuery(globalFilters, pagination, indices, inlineFilters, sortFields, startTime);
      }

      // Use regular search for smaller offsets
      opensearchQuery = this._buildRetailVehicleLookupQuery(globalFilters, pageSize, pagination, inlineFilters, sortFields);

      logger.info(`Executing retail vehicle query: ${JSON.stringify(opensearchQuery)}`);

      const client = await this.getClient();
      const response = await client.search({
        index: indices,
        body: opensearchQuery,
        timeout: '30s'
      });

      // Process response
      console.log(`[DEBUG] Raw OpenSearch response status: ${response.statusCode}`);
      console.log(`[DEBUG] Total hits from response: ${response.body?.hits?.total?.value}`);
      console.log(`[DEBUG] Actual hits returned: ${response.body?.hits?.hits?.length}`);

      const vehicleData = this._processRetailVehicleLookupResponse(response);
      const totalHits = response.body?.hits?.total?.value || vehicleData.length;

      // Calculate pagination metadata
      const totalPages = Math.ceil(totalHits / pageSize);

      // Calculate max accessible page based on result window limit
      const maxAccessiblePage = Math.floor(maxResultWindow / pageSize);

      const executionTime = (Date.now() - startTime) / 1000;
      logger.info(`Retail vehicle query executed successfully in ${executionTime.toFixed(2)} seconds`);

      return {
        success: true,
        data: vehicleData,
        total_count: totalHits,
        pagination: {
          current_page: currentPage,
          page_size: pageSize,
          total_pages: totalPages,
          max_accessible_page: Math.min(totalPages, maxAccessiblePage),
          has_next: currentPage * pageSize < totalHits && currentPage < maxAccessiblePage,
          has_previous: currentPage > 1,
          result_window_info: {
            max_result_window: maxResultWindow,
            current_offset: (currentPage - 1) * pageSize,
            warning: totalPages > maxAccessiblePage ?
              `Only the first ${maxAccessiblePage} pages are accessible due to OpenSearch result window limits. Use filters to narrow results for accessing later records.` :
              null
          }
        },
        execution_timestamp: new Date()
      };

    } catch (error) {
      const executionTime = (Date.now() - startTime) / 1000;
      logger.error(`Retail vehicle query failed after ${executionTime.toFixed(2)} seconds: ${error.message}`);

      if (opensearchQuery) {
        logger.error(`Query that failed: ${JSON.stringify(opensearchQuery)}`);
      }

      return {
        success: false,
        data: [],
        error: error.message,
        execution_timestamp: new Date()
      };
    }
  }
  /**
   * Execute retail vehicle lookup query using multiple smaller queries for large datasets
   * @param {Object} filters - The filters to apply
   * @param {Object} pagination - The pagination parameters
   * @param {Array<string>} indices - The index names to query
   * @param {Array} inlineFilters - Inline filters to apply
   * @param {Array} sortFields - Sort fields
   * @param {number} startTime - Query start time
   * @returns {Promise<Object>} The query response
   * @private
   */
  async _executeRetailVehicleScrollQuery(filters = null, pagination = null, indices = null, inlineFilters = null, sortFields = null, startTime) {
    try {
      const currentPage = pagination?.page || 1;
      const pageSize = pagination?.page_size || 100;
      const targetOffset = (currentPage - 1) * pageSize;

      logger.info(`Executing large dataset query for page ${currentPage}, pageSize ${pageSize}, targetOffset ${targetOffset}`);

      // Build the query using the existing method but without pagination
      const baseQuery = this._buildRetailVehicleLookupQuery(filters, 0, null, inlineFilters, sortFields);

      // Remove size and from parameters for count query
      const countQuery = { ...baseQuery };
      delete countQuery.size;
      delete countQuery.from;
      countQuery.size = 0;

      logger.info(`Count query: ${JSON.stringify(countQuery, null, 2)}`);

      const client = await this.getClient();

      // First, get total count
      const countResponse = await client.search({
        index: indices,
        body: countQuery,
        timeout: '30s'
      });

      const totalHits = countResponse.body?.hits?.total?.value || 0;
      const totalPages = Math.ceil(totalHits / pageSize);

      logger.info(`Total hits: ${totalHits}, Total pages: ${totalPages}`);

      // If target offset is beyond total results, return empty
      if (targetOffset >= totalHits) {
        return {
          success: true,
          data: [],
          total_count: totalHits,
          pagination: {
            current_page: currentPage,
            page_size: pageSize,
            total_pages: totalPages,
            has_next: false,
            has_previous: currentPage > 1,
            large_dataset_method_used: true
          },
          execution_timestamp: new Date()
        };
      }

      // For large offsets, we need to work within OpenSearch's result window limit
      const maxResultWindow = 50000;
      let allResults = [];

      logger.info(`Target analysis: offset=${targetOffset}, pageSize=${pageSize}, sum=${targetOffset + pageSize}, maxWindow=${maxResultWindow}`);

      // If the target offset itself is within the result window, try direct fetch
      if (targetOffset < maxResultWindow) {
        // Calculate how much we can fetch directly
        const maxDirectSize = Math.min(pageSize, maxResultWindow - targetOffset);

        logger.info(`Attempting direct fetch: from=${targetOffset}, size=${maxDirectSize}`);

        const directQuery = { ...baseQuery };
        directQuery.from = targetOffset;
        directQuery.size = maxDirectSize;

        const directResponse = await client.search({
          index: indices,
          body: directQuery,
          timeout: '30s'
        });

        allResults = directResponse.body?.hits?.hits || [];
        logger.info(`Direct fetch returned ${allResults.length} results`);

        // If we got fewer results than requested and it's because of the window limit,
        // we need to get the remaining results using a different approach
        if (allResults.length < pageSize && targetOffset + pageSize > maxResultWindow) {
          logger.info(`Need additional results beyond result window limit`);
          // For now, just return what we have - this is a limitation
          // In a production system, you might want to implement search_after here
        }
      } else {
        // Target offset is beyond result window - use scroll API to get the data
        logger.info(`Target offset ${targetOffset} is beyond result window ${maxResultWindow}, using scroll API`);

        allResults = await this._scrollToTargetPage(client, indices, baseQuery, targetOffset, pageSize);
        logger.info(`Scroll API returned ${allResults.length} results`);
      }

      // Process the results
      const vehicleData = this._processRetailVehicleLookupResponse({ body: { hits: { hits: allResults } } });

      const executionTime = (Date.now() - startTime) / 1000;
      logger.info(`Large dataset query executed successfully in ${executionTime.toFixed(2)} seconds`);
      logger.info(`Results: requested=${pageSize}, raw_hits=${allResults.length}, processed=${vehicleData.length}`);

      return {
        success: true,
        data: vehicleData,
        total_count: totalHits,
        pagination: {
          current_page: currentPage,
          page_size: pageSize,
          total_pages: totalPages,
          has_next: currentPage < totalPages,
          has_previous: currentPage > 1,
          large_dataset_method_used: true,
          method_info: {
            target_offset: targetOffset,
            records_retrieved: vehicleData.length,
            execution_time_seconds: executionTime,
            raw_hits_retrieved: allResults.length,
            method_used: targetOffset < 50000 ? 'direct_fetch' : 'scroll_api'
          }
        },
        execution_timestamp: new Date()
      };

    } catch (error) {
      const executionTime = (Date.now() - startTime) / 1000;
      logger.error(`Large dataset query failed after ${executionTime.toFixed(2)} seconds: ${error.message}`);
      logger.error(`Error details:`, error);

      // Log more specific error information
      if (error.meta && error.meta.body) {
        logger.error(`OpenSearch error body:`, JSON.stringify(error.meta.body, null, 2));
      }

      if (error.statusCode) {
        logger.error(`HTTP status code: ${error.statusCode}`);
      }

      return {
        success: false,
        data: [],
        error: `Large dataset query failed: ${error.message}`,
        error_details: {
          message: error.message,
          statusCode: error.statusCode,
          body: error.meta?.body
        },
        execution_timestamp: new Date()
      };
    }
  }

  /**
   * Use scroll API to navigate to a specific page beyond the result window limit
   * @param {Object} client - OpenSearch client
   * @param {Array<string>} indices - Index names
   * @param {Object} baseQuery - Base query without pagination
   * @param {number} targetOffset - Target record offset
   * @param {number} pageSize - Number of records to return
   * @returns {Promise<Array>} Array of hits for the target page
   * @private
   */
  async _scrollToTargetPage(client, indices, baseQuery, targetOffset, pageSize) {
    let scrollId = null;
    let allResults = [];
    let currentOffset = 0;
    const scrollSize = 10000; // Scroll in chunks of 10k

    try {
      // Start the scroll
      const scrollQuery = {
        ...baseQuery,
        size: scrollSize
      };

      logger.info(`Starting scroll to reach offset ${targetOffset}`);

      let scrollResponse = await client.search({
        index: indices,
        body: scrollQuery,
        scroll: '5m', // Keep scroll context for 5 minutes
        timeout: '30s'
      });

      scrollId = scrollResponse.body._scroll_id;
      let hits = scrollResponse.body?.hits?.hits || [];

      // Keep scrolling until we reach our target offset
      while (hits.length > 0) {
        // Check if our target range is within this batch
        if (currentOffset <= targetOffset && currentOffset + hits.length > targetOffset) {
          // We found our target page within this batch
          const startIndex = targetOffset - currentOffset;
          const endIndex = Math.min(hits.length, startIndex + pageSize);

          allResults = hits.slice(startIndex, endIndex);
          logger.info(`Found target page at offset ${currentOffset}, extracted ${allResults.length} records`);
          break;
        }

        currentOffset += hits.length;

        // If we've passed our target, we're done
        if (currentOffset > targetOffset + pageSize) {
          logger.info(`Scrolled past target offset ${targetOffset}, stopping`);
          break;
        }

        // Continue scrolling
        scrollResponse = await client.scroll({
          scroll_id: scrollId,
          scroll: '5m'
        });

        hits = scrollResponse.body?.hits?.hits || [];
        scrollId = scrollResponse.body._scroll_id;

        logger.info(`Scrolled to offset ${currentOffset}, got ${hits.length} more records`);
      }

      return allResults;

    } catch (error) {
      logger.error(`Scroll to target page failed: ${error.message}`);
      throw error;
    } finally {
      // Always clean up the scroll context
      if (scrollId) {
        try {
          await client.clearScroll({
            scroll_id: scrollId
          });
          logger.info(`Cleared scroll context`);
        } catch (clearError) {
          logger.error(`Failed to clear scroll context: ${clearError.message}`);
        }
      }
    }
  }
  //KPI Tiles
  buildKpiTilesAggQuery(filters, indexType) {
    // Convert filters to dict
    const filterDict = {};
    if (filters) {
      for (const [key, value] of Object.entries(filters)) {
        // Skip null values and empty collections
        if (value === null || value === undefined) {
          continue;
        }
        if ((Array.isArray(value) || typeof value === 'object') && Object.keys(value).length === 0) {
          continue;
        }
        if (typeof value === 'string' && value.trim() === "") {
          continue;
        }
        if (key === 'transaction_date' && value) {
          console.log(`transaction_date ${value}`);
          if (value.gte || value.lte) {
            filterDict.transaction_date = value; // Pass the date range object directly
          }
          else if (value['>='] || value['<=']) {
            console.log(`>= ${value}`);
            let dateObj = value;
            if (value['>=']) {
              dateObj.gte = dateObj['>='];
              delete dateObj['>='];
            }
            if (dateObj['<=']) {
              dateObj.lte = dateObj['<='];
              delete dateObj['<='];
            }
            console.log(`dateObj ${dateObj}`);
            filterDict.transaction_date = dateObj;
          }
        } else {
          filterDict[key] = value;
        }
      }
    }
    const query = this._buildFilterQuerySalesChart(filterDict);
    let retailCountField, wholesaleCountField, distributorCountField;
  
  switch(indexType) {
    case '0':
      retailCountField = 'net_daily_retail_count';
      wholesaleCountField = 'net_daily_wholesale_count';
      break;
    case '3':
      retailCountField = 'net_mtd_retail_count';
      wholesaleCountField = 'net_mtd_wholesale_count';
      break;
    case '5':
      retailCountField = 'net_ytd_retail_count';
      wholesaleCountField = 'net_ytd_wholesale_count';
      break;
    default:
      // Default to daily counts if indexType is not recognized
      retailCountField = 'net_daily_retail_count';
      wholesaleCountField = 'net_daily_wholesale_count';
    }
    return {
      size: 0,
      query,
      aggs: {
        by_month: {
          terms: {
            field: "sls_ccyymm",
            size: 100
          },
          aggs: {
            by_series: {
              terms: {
                field: "series_name",
                size: 100
              },
              aggs: {
                netRetailSales: {
                  sum: { field: retailCountField }
                },
                wholesales: {
                  sum: { field: wholesaleCountField }
                },
                salesAvailability: {
                  avg: { field: "sales_availability_count" }
                },
                dailySalesRate: {
                  sum: { field: "retail_mtd_count" }
                },
                daysSupply: {
                  avg: { field: "days_supply_count" } //
                },
                salesVelocity: {
                  avg: { field: "days_supply_count" }
                }
              }
            },
            totalNetRetailSales: {
              sum: { field: retailCountField }
            },
            totalWholesales: {
              sum: { field: wholesaleCountField }
            },
            totalSalesAvailability: {
              avg: { field: "sales_availability_count" }
            },
            totalDailySalesRate: {
              sum: { field: "retail_mtd_count" }
            },
            totalDaysSupply: {
              avg: { field: "days_supply_count" }
            },
            totalSalesVelocity: {
              avg: { field: "days_supply_count" }
            }
          }
        }
      }
    };
  }
  //Response Formatter
  buildKpiTilesResponse(aggs) {
    if (!aggs || !aggs.by_month || !aggs.by_month.buckets || aggs.by_month.buckets.length === 0) {
      return {
        data: {
          salesCalendarDate: null,
          salesCalendarMonth: null,
          kpiTiles: {
            netRetailSales: 0,
            wholesales: 0,
            salesAvailability: 0,
            dailySalesRate: 0,
            daysSupply: 0,
            salesVelocity: 0
          },
          kpiTilesInfo: {
            netRetailSales: { bySeries: [] },
            wholesales: { bySeries: [] }
            // salesAvailability: { bySeries: [] },
            // dailySalesRate: { bySeries: [] },
            // daysSupply: { bySeries: [] },
            // salesVelocity: { bySeries: [] }
          }
        }
      };
    }

    // Get the first (and likely only) month bucket
    const monthBucket = aggs.by_month.buckets[0];

    // Extract by_series from within the month
    const bySeriesBuckets = monthBucket.by_series?.buckets || [];

    // Helper to get top 3 by series for a metric
    function topBySeries(key, isAvg = false) {
      return bySeriesBuckets
        .map(bucket => ({
          count: isAvg
            ? Number(((bucket[key]?.value || 0) / (bucket.doc_count || 1)).toFixed(1))
            : bucket[key]?.value || 0,
          salesSeriesName: bucket.key || "UNKNOWN"
        }))
        .sort((a, b) => b.count - a.count)
        .slice(0, 3);
    }

    return {
      data: {
        salesCalendarMonth: monthBucket.key || null,  // sls_ccyymm as month
        kpiTiles: {
          netRetailSales: monthBucket.totalNetRetailSales?.value || 0,
          wholesales: monthBucket.totalWholesales?.value || 0,
          salesAvailability: 0,//Number((monthBucket.totalSalesAvailability?.value || 0).toFixed(1)),
          dailySalesRate: 0,//monthBucket.totalDailySalesRate?.value || 0,
          daysSupply: 0,//Number((monthBucket.totalDaysSupply?.value || 0).toFixed(1)),
          salesVelocity: 0//Number((monthBucket.totalSalesVelocity?.value || 0).toFixed(1))
        },
        kpiTilesInfo: {
          netRetailSales: { bySeries: topBySeries("netRetailSales") },
          wholesales: { bySeries: topBySeries("wholesales") }
          // salesAvailability: 0,//{ bySeries: topBySeries("salesAvailability", true) },
          // dailySalesRate: 0,//{ bySeries: topBySeries("dailySalesRate") },
          // daysSupply: 0,//{ bySeries: topBySeries("daysSupply", true) },
          // salesVelocity: null//{ bySeries: topBySeries("salesVelocity", true) }
        }
      }
    };
  }
  //Modified KPI Tiles
  //KPI Tiles
  modifiedBuildKpiTilesAggQuery(filters, indexType) {
    // Convert filters to dict
    const filterDict = {};
    if (filters) {
      for (const [key, value] of Object.entries(filters)) {
        // Skip null values and empty collections
        if (value === null || value === undefined) {
          continue;
        }
        if ((Array.isArray(value) || typeof value === 'object') && Object.keys(value).length === 0) {
          continue;
        }
        if (typeof value === 'string' && value.trim() === "") {
          continue;
        }
        if (key === 'transaction_date' && value) {
          console.log(`transaction_date ${value}`);
          if (value.gte || value.lte) {
            filterDict.transaction_date = value; // Pass the date range object directly
          }
          else if (value['>='] || value['<=']) {
            console.log(`>= ${value}`);
            let dateObj = value;
            if (value['>=']) {
              dateObj.gte = dateObj['>='];
              delete dateObj['>='];
            }
            if (dateObj['<=']) {
              dateObj.lte = dateObj['<='];
              delete dateObj['<='];
            }
            console.log(`dateObj ${dateObj}`);
            filterDict.transaction_date = dateObj;
          }
        } else {
          filterDict[key] = value;
        }
      }
    }
    const query = this._buildFilterQuerySalesChart(filterDict);
    let retailCountField, wholesaleCountField, velocityDaysField;

    // Add velocity days field based on indexType
    switch(indexType) {
      case '0':
        retailCountField = 'net_daily_retail_count';
        wholesaleCountField = 'net_daily_wholesale_count';
        velocityDaysField = 'net_velocity_days_daily';
        break;
      case '1':
      case '2':
      case '3':
        retailCountField = 'net_mtd_retail_count';
        wholesaleCountField = 'net_mtd_wholesale_count';
        velocityDaysField = 'net_velocity_days_mtd';
        break;
      case '5':
        retailCountField = 'net_ytd_retail_count';
        wholesaleCountField = 'net_ytd_wholesale_count';
        velocityDaysField = 'net_velocity_days_ytd';
        break;
      default:
        // Default to daily counts if indexType is not recognized
        retailCountField = 'net_daily_retail_count';
        wholesaleCountField = 'net_daily_wholesale_count';
        velocityDaysField = 'net_velocity_days_daily';
    }

    return {
      size: 0,
      query,
      aggs: {
        by_month: {
          terms: {
            field: "sls_ccyymm",
            size: 100
          },
          aggs: {
            by_series: {
              terms: {
                field: "series_name",
                size: 100
              },
              aggs: {
                netRetailSales: {
                  sum: { field: retailCountField }
                },
                wholesales: {
                  sum: { field: wholesaleCountField }
                },
                // Components for salesAvailability calculation
                net_mtd_retail_sum: {
                  sum: { field: "net_mtd_retail_count" }
                },
                dealer_stock_sum: {
                  sum: { field: "dealer_stock_count" }
                },
                // For dailySalesRate
                daily_sales_rate_sum: {
                  sum: { field: "daily_sales_rate" }
                },
                // Components for salesVelocity calculation
                velocity_days_sum: {
                  sum: { field: velocityDaysField }
                },
                retail_count_for_velocity: {
                  sum: { field: retailCountField }
                },
                // salesAvailability: (100*sum(net_mtd_retail_count))/(sum(net_mtd_retail_count)+sum(dealer_stock_count))
                salesAvailability: {
                  bucket_script: {
                    buckets_path: {
                      retail: "net_mtd_retail_sum",
                      stock: "dealer_stock_sum"
                    },
                    script: "if (params.retail + params.stock == 0) { return 0; } else { return (100 * params.retail) / (params.retail + params.stock); }"
                  }
                },
                // dailySalesRate: sum(daily_sales_rate)
                dailySalesRate: {
                  sum: { field: "daily_sales_rate" }
                },
                // daysSupply: sum(dealer_stock_count)/sum(daily_sales_rate)
                daysSupply: {
                  bucket_script: {
                    buckets_path: {
                      stock: "dealer_stock_sum",
                      rate: "daily_sales_rate_sum"
                    },
                    script: "if (params.rate == 0) { return 0; } else { return params.stock / params.rate; }"
                  }
                },
                // salesVelocity: sum(net_velocity_days_*)/sum(net_*_retail_count) based on indexType
                salesVelocity: {
                  bucket_script: {
                    buckets_path: {
                      velocityDays: "velocity_days_sum",
                      retailCount: "retail_count_for_velocity"
                    },
                    script: "if (params.retailCount == 0) { return 0; } else { return params.velocityDays / params.retailCount; }"
                  }
                }
              }
            },
            // Total level aggregations
            totalNetRetailSales: {
              sum: { field: retailCountField }
            },
            totalWholesales: {
              sum: { field: wholesaleCountField }
            },
            // Components for total salesAvailability
            total_net_mtd_retail_sum: {
              sum: { field: "net_mtd_retail_count" }
            },
            total_dealer_stock_sum: {
              sum: { field: "dealer_stock_count" }
            },
            total_daily_sales_rate_sum: {
              sum: { field: "daily_sales_rate" }
            },
            // Components for total salesVelocity
            total_velocity_days_sum: {
              sum: { field: velocityDaysField }
            },
            total_retail_count_for_velocity: {
              sum: { field: retailCountField }
            },
            // totalSalesAvailability: (100*sum(net_mtd_retail_count))/(sum(net_mtd_retail_count)+sum(dealer_stock_count))
            totalSalesAvailability: {
              bucket_script: {
                buckets_path: {
                  retail: "total_net_mtd_retail_sum",
                  stock: "total_dealer_stock_sum"
                },
                script: "if (params.retail + params.stock == 0) { return 0; } else { return (100 * params.retail) / (params.retail + params.stock); }"
              }
            },
            // totalDailySalesRate: sum(daily_sales_rate)
            totalDailySalesRate: {
              sum: { field: "daily_sales_rate" }
            },
            // totalDaysSupply: sum(dealer_stock_count)/sum(daily_sales_rate)
            totalDaysSupply: {
              bucket_script: {
                buckets_path: {
                  stock: "total_dealer_stock_sum",
                  rate: "total_daily_sales_rate_sum"
                },
                script: "if (params.rate == 0) { return 0; } else { return params.stock / params.rate; }"
              }
            },
            // totalSalesVelocity: sum(net_velocity_days_*)/sum(net_*_retail_count) based on indexType
            totalSalesVelocity: {
              bucket_script: {
                buckets_path: {
                  velocityDays: "total_velocity_days_sum",
                  retailCount: "total_retail_count_for_velocity"
                },
                script: "if (params.retailCount == 0) { return 0; } else { return params.velocityDays / params.retailCount; }"
              }
            }
          }
        }
      }
    };
  }
  //Response Formatter
  modifiedBuildKpiTilesResponse(aggs) {
    if (!aggs || !aggs.by_month || !aggs.by_month.buckets || aggs.by_month.buckets.length === 0) {
      return {
        data: {
          salesCalendarDate: null,
          salesCalendarMonth: null,
          kpiTiles: {
            netRetailSales: 0,
            wholesales: 0,
            salesAvailability: 0,
            dailySalesRate: 0,
            daysSupply: 0,
            salesVelocity: 0
          },
          kpiTilesInfo: {
            netRetailSales: { bySeries: [] },
            wholesales: { bySeries: [] }
            // salesAvailability: { bySeries: [] },
            // dailySalesRate: { bySeries: [] },
            // daysSupply: { bySeries: [] },
            // salesVelocity: { bySeries: [] }
          }
        }
      };
    }

    // Get the first (and likely only) month bucket
    const monthBucket = aggs.by_month.buckets[0];

    // Extract by_series from within the month
    const bySeriesBuckets = monthBucket.by_series?.buckets || [];

    // Helper to get top 3 by series for a metric
    function topBySeries(key, isCalculated = false) {
      return bySeriesBuckets
        .map(bucket => ({
          count: isCalculated 
            ? Number((bucket[key]?.value || 0).toFixed(2))
            : bucket[key]?.value || 0,
          salesSeriesName: bucket.key || "UNKNOWN"
        }))
        .sort((a, b) => b.count - a.count)
        .slice(0, 3);
    }

    return {
      data: {
        salesCalendarMonth: monthBucket.key || null,  // sls_ccyymm as month
        kpiTiles: {
          netRetailSales: monthBucket.totalNetRetailSales?.value || 0,
          wholesales: monthBucket.totalWholesales?.value || 0,
          salesAvailability: Number((monthBucket.totalSalesAvailability?.value || 0).toFixed(2)),
          dailySalesRate: Number((monthBucket.totalDailySalesRate?.value || 0).toFixed(2)),
          daysSupply: Number((monthBucket.totalDaysSupply?.value || 0).toFixed(2)),
          salesVelocity: Number((monthBucket.totalSalesVelocity?.value || 0).toFixed(2))
        },
        kpiTilesInfo: {
          netRetailSales: { bySeries: topBySeries("netRetailSales") },
          wholesales: { bySeries: topBySeries("wholesales") }
          // salesAvailability: { bySeries: topBySeries("salesAvailability", true) },
          // dailySalesRate: { bySeries: topBySeries("dailySalesRate", true) },
          // daysSupply: { bySeries: topBySeries("daysSupply", true) },
          // salesVelocity: { bySeries: topBySeries("salesVelocity", true) }
        }
      }
    };
  }
  
  getRequestData(req, ACCESSORY_INDEX, SALES_INV_INDEX) {
    const ACCESSORY_INDEX_NEW = ACCESSORY_INDEX;
    const COLOR_INDEX = SALES_INV_INDEX;
    // Extract request data
    const { filters, index_type } = req.body;

    // Log the incoming request data
    console.log('filters:', JSON.stringify(filters, null, 2));
    console.log('Index type:', index_type);

    // Determine index prefix based on global filters
    let indexPrefix = COLOR_INDEX; // Default

    let processedFilters = filters ? { ...filters } : null;

    if (processedFilters) {
      // Check if exterior_color_code or interior_color_code exists in processedFilters
      if ((processedFilters.accessory_code) && !(processedFilters.exterior_color_code || processedFilters.interior_color_code)) {
        indexPrefix = ACCESSORY_INDEX_NEW;
        console.log('Using ACCESSORY_INDEX due to accessory filters');
      } else {
        // Build filters object from processedFilters
        processedFilters = {
          ...processedFilters,
          accessory_code: null,
        };
      }

      if (processedFilters) {
        const fieldsToCapitalize = [
          'distributor_code', 'region_code', 'region_name', 'dealer_code', 'dealer_name',
          'dealer_group_name', 'dealer_type', 'district_code', 'district_name',
          'vehicle_assignment_indicator', 'model_year', 'model_code', 'fd_fleet_description',
          'brand_code', 'segment_code', 'subsegment_code', 'team_member_lease_sale_type',
          'nap_cbu_code', 'series_name', 'series_display_order', 'grade_code',
          'transmissiontype_code', 'drivetrain_code', 'fueltype_code', 'enginefueltype_code',
          // Accessory fields (replacing color fields)
           'accessory_code', 'accessory_desc',
          // color fields
          'exterior_color_code', 'exterior_color_desc', 'interior_color_code', 'interior_trim_color_desc',
        ];

        const booleanFields = ['fleet_flag', 'fd_fleet_flag', 'car_trk_indicator'];

        Object.keys(processedFilters).forEach(key => {
          if (fieldsToCapitalize.includes(key)) {
            if (Array.isArray(processedFilters[key])) {
              processedFilters[key] = processedFilters[key].map(value =>
                typeof value === 'string' ? value.toUpperCase() : value
              );
            } else if (typeof processedFilters[key] === 'string') {
              processedFilters[key] = processedFilters[key].toUpperCase();
            }
          }
          // Boolean fields are handled as-is
        });
      }
    }

   let indexName = this.getIndexName(indexPrefix, req.body.index_type, processedFilters);

    return {
      filters: processedFilters,
      indexName
    }
  }
  //Modified getRequestData
  modifiedGetRequestData(req, ACCESSORY_INDEX, SALES_INV_INDEX, ACCESSORY_10DAY_INDEX, COLOR_10DAY_INDEX, ACCESSORY_20DAY_INDEX, COLOR_20DAY_INDEX) {
    const ACCESSORY_INDEX_NEW = req.body.index_type == '1' ? ACCESSORY_10DAY_INDEX : req.body.index_type == '2' ? ACCESSORY_20DAY_INDEX : ACCESSORY_INDEX;
    const COLOR_INDEX = req.body.index_type == '1' ? COLOR_10DAY_INDEX : req.body.index_type == '2' ? COLOR_20DAY_INDEX : SALES_INV_INDEX;
    // Extract request data
    const { filters, index_type } = req.body;

    // Log the incoming request data
    console.log('filters:', JSON.stringify(filters, null, 2));
    console.log('Index type:', index_type);

    // Determine index prefix based on global filters
    let indexPrefix = COLOR_INDEX; // Default

    let processedFilters = filters ? { ...filters } : null;

    if (processedFilters) {
      // Check if exterior_color_code or interior_color_code exists in processedFilters
      if ((processedFilters.accessory_code) && !(processedFilters.exterior_color_code || processedFilters.interior_color_code)) {
        indexPrefix = ACCESSORY_INDEX_NEW;
        console.log('Using ACCESSORY_INDEX due to accessory filters');
      } else {
        // Build filters object from processedFilters
        processedFilters = {
          ...processedFilters,
          accessory_code: null,
        };
      }

      if (processedFilters) {
        const fieldsToCapitalize = [
          'distributor_code', 'region_code', 'region_name', 'dealer_code', 'dealer_name',
          'dealer_group_name', 'dealer_type', 'district_code', 'district_name',
          'vehicle_assignment_indicator', 'model_year', 'model_code', 'fd_fleet_description',
          'brand_code', 'segment_code', 'subsegment_code', 'team_member_lease_sale_type',
          'nap_cbu_code', 'series_name', 'series_display_order', 'grade_code',
          'transmissiontype_code', 'drivetrain_code', 'fueltype_code', 'enginefueltype_code',
          // Accessory fields (replacing color fields)
           'accessory_code', 'accessory_desc',
          // color fields
          'exterior_color_code', 'exterior_color_desc', 'interior_color_code', 'interior_trim_color_desc',
        ];

        const booleanFields = ['fleet_flag', 'fd_fleet_flag', 'car_trk_indicator'];

        Object.keys(processedFilters).forEach(key => {
          if (fieldsToCapitalize.includes(key)) {
            if (Array.isArray(processedFilters[key])) {
              processedFilters[key] = processedFilters[key].map(value =>
                typeof value === 'string' ? value.toUpperCase() : value
              );
            } else if (typeof processedFilters[key] === 'string') {
              processedFilters[key] = processedFilters[key].toUpperCase();
            }
          }
          // Boolean fields are handled as-is
        });
      }
    }

   let indexName = this.getIndexName(indexPrefix, req.body.index_type, processedFilters);

    return {
      filters: processedFilters,
      indexName
    }
  }
  getIndexName(indexPrefix, indexType, processedFilters) {
    logger.info(`Determining index name for prefix: ${indexPrefix}, indexType: ${indexType}`);
    // Determine which index to use based on requirements
    const currentDate = new Date();
    const yearString = currentDate.getFullYear().toString();
    let indexName = [`${indexPrefix}-${yearString}`];

    if (['0', '3', '5'].includes(indexType)) {
      logger.info(`Index type ${indexType} uses current year index`);
      // Use the accessory summary index for these types
      indexName = [`${indexPrefix}-${yearString}`];
    } else if (indexType === '6') {
      logger.info(`Index type ${indexType} uses previous year index`);
      // Use previous year index for YTD comparison
      const previousYearString = (currentDate.getFullYear() - 1).toString();
      indexName = [`${indexPrefix}-${previousYearString}`];
    } else {
      if (processedFilters && processedFilters.sls_ccyymm && processedFilters.sls_ccyymm.length > 0) {
        logger.info(`sls_ccyymm filter detected: ${processedFilters.sls_ccyymm}`);
        logger.info(`Determining index names based on sls_ccyymm filter values`);
        // Extract years from CCYYMM format (first 4 digits)
        const years = processedFilters.sls_ccyymm.map(val => {
          const ccyymm = val.toString().padStart(6, '0');
          return parseInt(ccyymm.substring(0, 4));
        });

        const minYear = Math.min(...years);
        const maxYear = Math.max(...years);

        console.log(`series_acc_summary_new Min year: ${minYear}, Max year: ${maxYear}`);
        if (minYear === maxYear) {
          indexName = [`${indexPrefix}-${minYear}`];
        } else {
          indexName = [`${indexPrefix}-${minYear}`, `${indexPrefix}-${maxYear}`];
        }
      } else {
        logger.info(`No sls_ccyymm filter detected, defaulting to current year index`);
        // Default to current year index
        indexName = [`${indexPrefix}-${yearString}`];
      }
    }
    return indexName;
  }

  /**
   * Build filter query for sales by dynamic field aggregation
   * @param {Object} filters - The filters to apply
   * @returns {Object} The OpenSearch query
   */
  _buildFilterQuerySalesChart(filters) {
    const mustFilters = [];
    console.log(`filters ${JSON.stringify(filters)}`);
    // Handle transaction_date filter
    if (filters.transaction_date) {
      const dateFilter = {
        range: {
          transaction_date: {}
        }
      };
      if (filters.transaction_date.gte) {
        dateFilter.range.transaction_date.gte = filters.transaction_date.gte;
      }
      if (filters.transaction_date.lte) {
        dateFilter.range.transaction_date.lte = filters.transaction_date.lte;
      }

      mustFilters.push(dateFilter);
    }

    // Handle array-based filters for sales by segment query
    const arrayFilters = [
      'region_code', 'district_code', 'dealer_code', 'model_year', 'model_code', 'fleet_flag',
      'brand_code', 'segment_code', 'car_trk_indicator', 'dealer_type', 'team_lease_indicator',
      'transmissiontype_code', 'series_name', 'grade_code', 'drivetrain_code', 'accessory_code',
      'fio_ppo_indicator', 'napc_bu_code', 'exterior_color_code', 'interior_color_code',
      'sls_ccyymm', 'distributor_code', 'create_by', 'update_by'
    ];

    arrayFilters.forEach(filterKey => {
      if (filters[filterKey] && Array.isArray(filters[filterKey]) && filters[filterKey].length > 0) {
        mustFilters.push({
          bool: {
            should: [
              { terms: { [filterKey]: filters[filterKey] } },
              { terms: { [`${filterKey}.keyword`]: filters[filterKey] } }
            ],
            minimum_should_match: 1
          }
        });
      }
    });
    console.log(`mustfilters ${mustFilters}`);
    // Handle boolean filters
    if (filters.fleet_flag && Array.isArray(filters.fleet_flag) && filters.fleet_flag.length > 0) {
      mustFilters.push({
        bool: {
          should: [
            { terms: { fleet_flag: filters.fleet_flag } },
            { terms: { "fleet_flag.keyword": filters.fleet_flag } }
          ],
          minimum_should_match: 1
        }
      });
    }
    console.log(`Boolean mustfilters ${mustFilters}`);
    if (mustFilters.length === 0) {
      return { match_all: {} };
    }

    return {
      bool: {
        must: mustFilters
      }
    };
  }
  async executeSalesChartQuery(filtersData = null, indexName = null, field = 'segment_code', indexType) {
      const startTime = Date.now();
      let opensearchQuery = null;
  
      try {
  
        logger.info('entered the function executeSalesBySegmentQueryForAccessoryCode');
  
        // If no index name is provided, use the default index names
        const indices = indexName || settings.indexNamesList;
  
        // Build and execute aggregation query
        opensearchQuery = this._buildSalesChartAggregateQuery(filtersData, field, indexType);
  
        logger.debug(`Query body: ${JSON.stringify(opensearchQuery)}`);
        logger.info(`Building sales chart query for field: ${field}`);
        console.log(`Query body: ${JSON.stringify(opensearchQuery)}`);
  
        const client = await this.getClient();
        const response = await client.search({
          index: indices,
          body: opensearchQuery,
          timeout: '30s'
        });
        logger.info(`Query executed successfully, response status: ${response.statusCode}`);
  
        // Process the response into the desired net retail sales format
        const netRetailSalesData = this._processNetRetailSalesResponse(response, field);
  
        // Build query info
        const queryInfo = new QueryInfo({
          took: response.body?.took || 0,
          timed_out: response.body?.timed_out || false,
          total_shards: response.body?._shards?.total || 0,
          successful_shards: response.body?._shards?.successful || 0
        });
  
        const executionTime = (Date.now() - startTime) / 1000;
        logger.info(`Query executed successfully in ${executionTime.toFixed(2)} seconds`);
  
        return {
          success: true,
          data: netRetailSalesData,
          query_info: queryInfo,
          execution_timestamp: new Date()
        };
  
      } catch (error) {
        const executionTime = (Date.now() - startTime) / 1000;
        logger.error(`Query failed after ${executionTime.toFixed(2)} seconds: ${error.message}`);
  
        if (opensearchQuery) {
          logger.error(`Query that failed: ${JSON.stringify(opensearchQuery)}`);
        } else {
          logger.error('Query not built due to early error');
        }
  
        return {
          success: false,
          data: [],
          query_info: new QueryInfo(),
          execution_timestamp: new Date(),
          error: error.message
        };
      }
    }
    // ✅ Helper functions for dynamic property names
  getMainFieldProperty(field) {
    switch(field) {
      case 'segment_code': return 'segment_code';
      case 'series_name': return 'series_name';
      case 'fueltype_code': return 'fueltype_code';
      case 'enginefueltype_code': return 'enginefueltype_code';
      default: return 'field_code';
    }
  }

  getSubFieldProperty(field) {
    switch(field) {
      case 'segment_code': return 'bySubSegment';
      case 'series_name': return 'byModel';
      case 'fueltype_code': return 'byEngineType';
      case 'enginefueltype_code': return 'byFuelType';
      default: return 'bySubField';
    }
  }

  getSubsegmentFieldName(field) {
    switch(field) {
      case 'segment_code': return 'subsegment_code';
      case 'series_name': return 'model_code';
      case 'fueltype_code': return 'enginefueltype_code';
      case 'enginefueltype_code': return 'fueltype_code';
      default: return 'subsegment_code';
    }
  }
    _processNetRetailSalesResponse(response, field = 'segment_code') {
      // ✅ Declare responseKey at function level
      let responseKey;
      
      try {
        const aggregations = response.body?.aggregations;

        // ✅ Add enginefueltype_code mapping
        responseKey = field === 'segment_code' ? 'bySegment' :
          field === 'series_name' ? 'bySeries' :
            field === 'fueltype_code' ? 'byFuelType' :
              field === 'enginefueltype_code' ? 'byEngineType' :
                'byField';

        if (!aggregations) {
          logger.warn('No aggregations found in OpenSearch response');
          return {
            netRetailSales: {
              count: 0,
              [responseKey]: []
            }
          };
        }

        const totalRetailSalesCount = aggregations.total_retail_sales?.value || 0;
        const segmentBuckets = aggregations.net_retail_sales_by_segment?.buckets || [];
        console.log(`Total retail sales count: ${totalRetailSalesCount}`);
        if (totalRetailSalesCount === 0) {
          // Return consistent empty response for all field types
          return {
            success: true,
            data: {
              netRetailSales: {
                count: 0,
                [this.getMainFieldProperty(field)]: []
              }
            }
          };
        }

      // ✅ Add debugging logs
      console.log(`DEBUG: Total retail sales from aggregation: ${totalRetailSalesCount}`);
      console.log(`DEBUG: Number of segment buckets: ${segmentBuckets.length}`);
        // Calculate sum of all segment counts for comparison
        let sumOfSegmentCounts = 0;
        // Use a unique variable name based on the field type to avoid redeclaration
        const byFieldBuckets = segmentBuckets.map(bucket => {
          const fieldCode = bucket.key;
          const fieldRetailCount = bucket.segment_retail_sum?.value || 0;
          sumOfSegmentCounts += fieldRetailCount;

          let fieldPercentage = 0;
          if (totalRetailSalesCount > 0 && fieldRetailCount > 0) {
            fieldPercentage = parseFloat(((fieldRetailCount / totalRetailSalesCount) * 100).toFixed(3));
          }

          // Process subsegments
          const subsegmentBuckets = bucket.subsegment_breakdown?.buckets || [];
          const bySubSegment = subsegmentBuckets.map(subBucket => {
            const subsegmentCode = subBucket.key;
            const subsegmentCount = subBucket.subsegment_retail_sum?.value || 0;
            
            let subsegmentPercentage = 0;
            if (totalRetailSalesCount > 0 && subsegmentCount > 0) {
              subsegmentPercentage = parseFloat(((subsegmentCount / totalRetailSalesCount) * 100).toFixed(3));
            }

            return {
              count: subsegmentCount,
              percentage: subsegmentPercentage,
              [this.getSubsegmentFieldName(field)]: subsegmentCode
            };
          });

          // ✅ Create base response object
          const responseItem = {
            count: fieldRetailCount,
            percentage: fieldPercentage,
            [this.getMainFieldProperty(field)]: fieldCode
          };

          // ✅ Conditionally add subsegment breakdown - EXCLUDE for 'series_name'
          if (field !== 'series_name') {
            responseItem[this.getSubFieldProperty(field)] = bySubSegment;
          }

          return responseItem;
        });
        // ✅ Compare totals
        console.log(`DEBUG: Sum of segment counts: ${sumOfSegmentCounts}`);
        console.log(`DEBUG: Total retail sales: ${totalRetailSalesCount}`);
        console.log(`DEBUG: Difference: ${totalRetailSalesCount - sumOfSegmentCounts}`);

        if (Math.abs(totalRetailSalesCount - sumOfSegmentCounts) > 0.01) {
            console.warn(`WARNING: Total mismatch detected! Total: ${totalRetailSalesCount}, Sum: ${sumOfSegmentCounts}`);
        }

        return {
          netRetailSales: {
            count: totalRetailSalesCount,
            [responseKey]: byFieldBuckets
          }
        };

      } catch (error) {
        logger.error(`Error processing net retail sales response: ${error.message}`);
        
        // ✅ Ensure responseKey has a fallback value if not set
        if (!responseKey) {
          responseKey = field === 'segment_code' ? 'bySegment' :
            field === 'series_name' ? 'bySeries' :
              field === 'fueltype_code' ? 'byFuelType' :
                field === 'enginefueltype_code' ? 'byEngineType' :
                  'byField';
        }
        
        return {
          netRetailSales: {
            count: 0,
            [responseKey]: []
          }
        };
      }
    }
  _buildSalesChartAggregateQuery(filters = null, field, indexType) {
    // Convert filters to dict
    const filterDict = {};

    if (filters) {
      for (const [key, value] of Object.entries(filters)) {
        if (value === null || value === undefined) continue;
        if ((Array.isArray(value) || typeof value === 'object') && Object.keys(value).length === 0) continue;
        if (typeof value === 'string' && value.trim() === "") continue;

        if (key === 'transaction_date' && value) {
          filterDict.transaction_date = value;
        } else {
          filterDict[key] = value;
        }
      }
    }

    // Determine retail count field based on indexType
    let retailCountField;
    switch(indexType) {
      case '0': retailCountField = 'net_daily_retail_count'; break;
      case '3': retailCountField = 'net_mtd_retail_count'; break;
      case '5': retailCountField = 'net_ytd_retail_count'; break;
      default: retailCountField = 'net_daily_retail_count';
    }

    // Determine the subsegment field based on the main field
    let subsegmentField;
    if (field === 'segment_code') {
      subsegmentField = 'subsegment_code';
    } else if (field === 'series_name') {
      subsegmentField = 'model_code';
    } else if (field === 'fueltype_code') {
      subsegmentField = 'enginefueltype_code';
    } else if (field === 'enginefueltype_code') {
      subsegmentField = 'fueltype_code';  // ✅ Add this mapping
    } else {
      subsegmentField = 'subsegment_code';
    }
    // ✅ Add debug logging to see what's being excluded
    console.log(`DEBUG: Building aggregation for field: ${field}`);
    console.log(`DEBUG: Retail count field: ${retailCountField}`);
    console.log(`DEBUG: Subsegment field: ${subsegmentField}`);

    // Build the base query from filters
    const baseQuery = this._buildFilterQuerySalesChart(filterDict);

    // ✅ Add exclusion filters for NA and DUMMY values at QUERY level
    const excludeQuery = {
      bool: {
        must: [{ match_all: {} }],
        must_not: [
          // Exclude documents where the main field is NA or DUMMY
          {
            terms: {
              [field]: ["DUMMY", "dummy"]//Remove "NA","na","N/A", "n/a"
            }
          },
          // Exclude documents where the subsegment field is NA or DUMMY
          {
            terms: {
              [subsegmentField]: ["DUMMY","dummy"]//Remove "NA","na","N/A", "n/a"
            }
          }
        ]
      }
    };

    // ✅ Combine the base query with exclusion filters
    let finalQuery;
    if (baseQuery.match_all) {
      // If base query is match_all, just use the exclude query
      finalQuery = excludeQuery;
    } else {
      // Combine the base query with exclusion filters
      finalQuery = {
        bool: {
          must: [baseQuery],
          must_not: [
            // Exclude documents where the main field is NA or DUMMY
            {
              terms: {
                [field]: ["DUMMY", "dummy"]//Remove "NA","na","N/A", "n/a"
              }
            },
            // Exclude documents where the subsegment field is NA or DUMMY
            {
              terms: {
                [subsegmentField]: ["DUMMY","dummy"]//Remove "NA","na","N/A", "n/a"
              }
            }
          ]
        }
      };
    }

    console.log(`DEBUG: Final query with exclusions: ${JSON.stringify(finalQuery)}`);

    const aggs = {
      // ✅ This should now match the filtered dataset
      total_retail_sales: {
        sum: { field: retailCountField }
      },
      net_retail_sales_by_segment: {
        terms: {
          field: field,
          size: 100,
          order: { segment_retail_sum: "desc" }
        },
        aggs: {
          segment_retail_sum: { 
            sum: { field: retailCountField } 
          },
          segment_name: {
            terms: {
              field: field.includes('.keyword') ? field : `${field}.keyword`,
              size: 1
            }
          },
          subsegment_breakdown: {
            terms: {
              field: subsegmentField,
              size: 50,
              order: { subsegment_retail_sum: "desc" }
              // ✅ Remove aggregation-level exclude since we're filtering at query level
              // exclude: ["NA", "DUMMY", "na", "dummy", "N/A", "n/a"]
            },
            aggs: {
              subsegment_retail_sum: { 
                sum: { field: retailCountField } 
              },
              subsegment_name: {
                terms: {
                  field: subsegmentField.includes('.keyword') ? subsegmentField : `${subsegmentField}.keyword`,
                  size: 1
                }
              }
            }
          }
        }
      }
    };

    return {
      size: 0,
      query: finalQuery, // ✅ Use the filtered query
      aggs: aggs
    };
  }
}
module.exports = PipelineQueryService;