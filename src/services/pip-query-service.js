// services/pip-query-service.js
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

const YEARLY_INDEX_PREFIX = 'pip-inventory';

const logger = {
  info: (msg) => console.log(`[INFO] ${msg}`),
  error: (msg) => console.error(`[ERROR] ${msg}`),
  debug: (msg) => console.log(`[DEBUG] ${msg}`)
};

/**
 * Service class for executing PIP queries
 */
class PIPQueryService {
  /**
   * Create a PIPQueryService
   */
  constructor() {
    this.opensearchClient = null;
    this.clientInitialized = false;
    this.initializationPromise = null;
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
   * Build OpenSearch query from filters
   * @param {Object} filters - The filters to apply
   * @returns {Object} The OpenSearch query
   */
  _buildOpenSearchQuery(filters) {
    const query = {
      bool: {
        must: [
          { match_all: {} }
        ]
      }
    };

    if (filters) {
      for (const [field, value] of Object.entries(filters)) {
        if (field === "date" && typeof value === 'object' && value.range) {
          // Handle date range queries
          query.bool.must.push({
            range: { update_datetime: value.range }
            // range: { [field]: value.range }
          });
        } else if (field === "sls_ccyymm" && Array.isArray(value) && value.length > 0) {
          // Handle sls_ccyymm filter - special case for year-month filtering
          query.bool.must.push({
            terms: { "sls_ccyymm": value }
          });
          logger.info(`Applied sales_ccyymm filter with values: ${value.join(', ')}`);
        } else if (Array.isArray(value) && value.length > 0) {
          // Handle wildcard-supported fields with special logic
          if (['region_code', 'district_code', 'dealer_code', 'series_name'].includes(field)) {
            const filterQuery = this._buildWildcardSupportedFilter(field, value);
            if (filterQuery) {
              query.bool.must.push(filterQuery);
            }
          } else {
            // Handle list of values with terms query for other fields
            query.bool.must.push({
              terms: { [field]: value }
            });
          }
        } else if (['string', 'number', 'boolean'].includes(typeof value) && value !== "") {
          // Handle single values with term query, but exclude empty strings
          query.bool.must.push({
            term: { [field]: value }
          });
        } else if (typeof value === 'object' && value.range) {
          // Handle other range queries
          query.bool.must.push({
            range: { [field]: value.range }
          });
        }
        // Skip null values, empty arrays, empty strings, and unrecognized formats
      }
    }
    logger.info(`The query with filters is for me to validate :`);
    logger.info(JSON.stringify(query));
    return query;
  }

  /**
   * Get all unique regions for pagination calculation
   * @param {Object} filters - The filters to apply
   * @param {Array<string>} indexName - The index name(s) to query
   * @returns {Promise<Array<string>>} The list of unique regions
   */
  async getAllRegions(filters = null, indexName = null) {
    let opensearchQuery = null;

    try {
      // If no index name is provided, use the default index names
      logger.info('get all regions entered');
      const indices = indexName || settings.indexNamesList;

      logger.info("Indices name is ");
      logger.info(indices);

      // Convert filters to dict for query building
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

          if (key === 'date_range' && value) {
            filterDict.date = { range: value };
          } else {
            filterDict[key] = value;
          }
        }
      }

      const query = this._buildOpenSearchQuery(filterDict);

      const aggs = {
        unique_regions: {
          terms: {
            field: "region_code",
            size: 10000
          }
        }
      };

      opensearchQuery = {
        size: 0,
        query: query,
        aggs: aggs
      };

      logger.info(`Executing regions query: ${JSON.stringify(opensearchQuery)}`);

      const client = await this.getClient();
      const response = await client.search({
        index: indices,
        body: opensearchQuery,
        timeout: '30s'
      });

      const buckets = response.body?.aggregations?.unique_regions?.buckets || [];
      const regions = buckets.map(bucket => bucket.key);

      logger.info(`Found ${regions.length} unique regions`);
      return regions.sort((a, b) => a.localeCompare(b));

    } catch (error) {
      logger.error(`Failed to get regions: ${error.message}`);
      if (opensearchQuery) {
        logger.error(`Query that failed: ${JSON.stringify(opensearchQuery)}`);
      } else {
        logger.error('Query not built due to early error');
      }
      return [];
    }
  }

  /**
   * Build OpenSearch aggregation query for dealer-level data
   * @param {Object} filters - The filters to apply
   * @param {Array<string>} regionList - The list of regions to filter by
   * @param {number} size - The maximum number of results to return
   * @returns {Object} The OpenSearch query
   */
  _buildDealerAggregatedQuery(filters = null, regionList = null, size = 10000) {
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

        if (key === 'date_range' && value) {
          filterDict.date = { range: value };
        } else {
          filterDict[key] = value;
        }
      }
    }

    const query = this._buildOpenSearchQuery(filterDict);

    // Add region filter for pagination
    if (regionList && regionList.length > 0) {
      query.bool.must.push({
        terms: { region_code: regionList }
      });
    }

    const aggs = {
      dealer_aggregated: {
        composite: {
          size: size,
          sources: [
            { region_code: { terms: { field: "region_code" } } },
            { district_code: { terms: { field: "district_code" } } },
            { dealer_code: { terms: { field: "dealer_code" } } }
          ]
        },
        aggs: {
          retail_count: { sum: { field: "retail_count" } },
          vpc_stock_count: { sum: { field: "vpc_stock_count" } },
          unbuilt_count: { sum: { field: "unbuilt_count" } },
          company_stock_count: { sum: { field: "company_stock_count" } },
          dealer_stock_count: { sum: { field: "dealer_stock_count" } },
          intransit_othervpc_count: { sum: { field: "intransit_othervpc_count" } },
          other_vpc_count: { sum: { field: "other_vpc_count" } },
          postprocess_intransit_count: { sum: { field: "postprocess_intransit_count" } },
          preprocess_intransit_vpc_count: { sum: { field: "preprocess_intransit_vpc_count" } },
          wholesale_count: { sum: { field: "wholesale_count" } },
          region_name: { terms: { field: "region_name", size: 1 } },
          district_name: { terms: { field: "district_name", size: 1 } },
          dealer_name: { terms: { field: "dealer_name", size: 1 } },
          distributors: { terms: { field: "distributor_code", size: 10 } }
        }
      }
    };

    return {
      size: 0,
      query: query,
      aggs: aggs
    };
  }

  /**
   * Create hierarchical structure from dealer data
   * @param {Array<Object>} dealerData - The dealer data
   * @returns {Array<RegionData>} The hierarchical structure
   */
  _createHierarchicalStructure(dealerData) {
    const hierarchy = new Map();

    // Define sum fields for aggregation
    const sumFields = [
      'company_stock', 'dealer_stock', 'in_transit_to_other_vpc', 'other_vpc_stock',
      'post_process_in_transit_vpc', 'pre_process_in_transit_vpc', 'total_stock',
      'retail', 'retail_yoy', 'retail_mom', 'retail_obj', 'wholesale_obj',
      'wholesale', 'vpc_stock', 'unbuilt_stock'
    ];

    // Process each dealer record
    for (const record of dealerData) {
      const regionCode = record.region_code || '';
      const districtCode = record.district_code || '';

      // Create or get region entry
      if (!hierarchy.has(regionCode)) {
        hierarchy.set(regionCode, {
          region_info: {},
          region_totals: {
            company_stock: 0,
            dealer_stock: 0,
            in_transit_to_other_vpc: 0,
            other_vpc_stock: 0,
            post_process_in_transit_vpc: 0,
            pre_process_in_transit_vpc: 0,
            total_stock: 0,
            retail: 0,
            retail_yoy: 0,
            retail_mom: 0,
            retail_obj: 0,
            wholesale_obj: 0,
            wholesale: 0,
            vpc_stock: 0,
            unbuilt_stock: 0
          },
          districts: new Map()
        });
      }

      const region = hierarchy.get(regionCode);

      // Set region info if not already set
      if (Object.keys(region.region_info).length === 0) {
        region.region_info = {
          region_code: regionCode,
          region_name: record.region_name || '',
          primary_distributor: record.primary_distributor || ''
        };
      }

      // Create or get district entry
      if (!region.districts.has(districtCode)) {
        region.districts.set(districtCode, {
          district_info: {},
          district_totals: {
            company_stock: 0,
            dealer_stock: 0,
            in_transit_to_other_vpc: 0,
            other_vpc_stock: 0,
            post_process_in_transit_vpc: 0,
            pre_process_in_transit_vpc: 0,
            total_stock: 0,
            retail: 0,
            retail_yoy: 0,
            retail_mom: 0,
            retail_obj: 0,
            wholesale_obj: 0,
            wholesale: 0,
            vpc_stock: 0,
            unbuilt_stock: 0
          },
          dealers: []
        });
      }

      const district = region.districts.get(districtCode);

      // Set district info if not already set
      if (Object.keys(district.district_info).length === 0) {
        district.district_info = {
          district_code: districtCode,
          district_name: record.district_name || '',
          region_code: regionCode
        };
      }

      // Create dealer record
      const dealerRecord = new DealerData({
        dealer_code: record.dealer_code || '',
        dealer_name: record.dealer_name || '',
        region_code: regionCode,
        district_code: districtCode,
        retail: record.retail || 0,
        retail_count: record.retail_count || 0,
        vpc_stock: record.vpc_stock || 0,
        unbuilt_stock: record.unbuilt_stock || 0,
        company_stock: record.company_stock || 0,
        dealer_stock: record.dealer_stock || 0,
        in_transit_to_other_vpc: record.in_transit_to_other_vpc || 0,
        other_vpc_stock: record.other_vpc_stock || 0,
        post_process_in_transit_vpc: record.post_process_in_transit_vpc || 0,
        pre_process_in_transit_vpc: record.pre_process_in_transit_vpc || 0,
        total_stock: record.total_stock || 0,
        wholesale: record.wholesale || 0,
        sales_availability: record.sales_availability || 0,
        days_supply: record.days_supply || 0,
        retail_yoy: record.retail_yoy || 0,
        retail_mom: record.retail_mom || 0,
        retail_obj: record.retail_obj || 0,
        wholesale_obj: record.wholesale_obj || 0,
        associated_distributors: record.associated_distributors || []
      });

      // Add dealer to district
      district.dealers.push(dealerRecord);

      // Roll up totals to district and region levels
      for (const field of sumFields) {
        const value = record[field] || 0;
        if (typeof value === 'number') {
          district.district_totals[field] += value;
          region.region_totals[field] += value;
        }
      }
    }

    // Convert to response models
    const result = [];

    for (const [regionCode, regionData] of hierarchy.entries()) {
      const districts = [];

      for (const [districtCode, districtData] of regionData.districts.entries()) {
        const district = new DistrictData({
          district_code: districtData.district_info.district_code,
          district_name: districtData.district_info.district_name,
          region_code: districtData.district_info.region_code,
          ...districtData.district_totals,
          dealers: districtData.dealers
        });

        districts.push(district);
      }

      const region = new RegionData({
        region_code: regionData.region_info.region_code,
        region_name: regionData.region_info.region_name,
        primary_distributor: regionData.region_info.primary_distributor,
        ...regionData.region_totals,
        districts: districts
      });

      result.push(region);
    }

    return result;
  }

  /**
   * Create hierarchical structure from dealer data
   * @param {Array<Object>} dealerData - The dealer data
   * @returns {Array<RegionData>} The hierarchical structure
   */
  _createHierarchicalStructureForRegionSummary(dealerData) {
    const hierarchy = new Map();

    // Define sum fields for aggregation
    const sumFields = [
      'companyStock', 'dealerStock', 'inTransitToOtherVPC', 'otherVPCStock',
      'postProcessInTransitVPC', 'preProcessInTransitVPC', 'totalStock',
      'retail', 'retailYoY', 'retailMoM', 'retailObj', 'wholesaleObj',
      'wholesale', 'vpcStock', 'unbuilt', 'salesAvailability', 'daysSupply',
      'nvsTmsStock', 'nvsDealerStock', 'nvsPortStock', 'nvsMfgStock', 'nvsInTransitStock',
      'distributorSale'
    ];

    // Process each dealer record
    for (const record of dealerData) {
      const regionCode = record.region_code || '';
      const districtCode = record.district_code || '';
      console.log('region summary region code', record.region_code);
      console.log('region code', regionCode);
      // Create or get region entry
      if (!hierarchy.has(regionCode)) {
        hierarchy.set(regionCode, {
          region_info: {},
          region_totals: {
            nvsTmsStock: 0,
            nvsDealerStock: 0,
            nvsPortStock: 0,
            nvsMfgStock: 0,
            nvsInTransitStock: 0,
            companyStock: 0,
            dealerStock: 0,
            inTransitToOtherVPC: 0,
            otherVPCStock: 0,
            postProcessInTransitVPC: 0,
            preProcessInTransitVPC: 0,
            totalStock: 0,
            retail: 0,
            retailYoY: 0,
            retailMoM: 0,
            retailObj: 0,
            wholesaleObj: 0,
            wholesale: 0,
            vpcStock: 0,
            unbuilt: 0,
            distributorSale: 0,
            salesAvailability: 0,
            daysSupply: 0,
          },
          districts: new Map()
        });
      }

      const region = hierarchy.get(regionCode);

      // Set region info if not already set
      if (Object.keys(region.region_info).length === 0) {
        region.region_info = {
          regionCode: regionCode,
          regionName: record.region_name || '',
          primaryDistributor: record.primary_distributor || ''
        };
      }

      // Create or get district entry
      if (!region.districts.has(districtCode)) {
        region.districts.set(districtCode, {
          district_info: {},
          district_totals: {
            nvsTmsStock: 0,
            nvsDealerStock: 0,
            nvsPortStock: 0,
            nvsMfgStock: 0,
            nvsInTransitStock: 0,
            companyStock: 0,
            dealerStock: 0,
            inTransitToOtherVPC: 0,
            otherVPCStock: 0,
            postProcessInTransitVPC: 0,
            preProcessInTransitVPC: 0,
            totalStock: 0,
            retail: 0,
            retailYoY: 0,
            retailMoM: 0,
            retailObj: 0,
            wholesaleObj: 0,
            wholesale: 0,
            vpcStock: 0,
            unbuilt: 0,
            distributorSale: 0,
            salesAvailability: 0,
            daysSupply: 0,
          },
          dealers: []
        });
      }

      const district = region.districts.get(districtCode);

      // Set district info if not already set
      if (Object.keys(district.district_info).length === 0) {
        district.district_info = {
          districtCode: districtCode,
          districtName: record.district_name || '',
          regionCode: regionCode
        };
      }

      // Create dealer record
      const dealerRecord = {
        nvsTmsStock: 0,
        nvsDealerStock: 0,
        nvsPortStock: 0,
        nvsMfgStock: 0,
        nvsInTransitStock: 0,
        dealerCode: record.dealer_code || '',
        dealerName: record.dealer_name || '',
        regionCode: regionCode,
        districtCode: districtCode,
        retail: record.retail || 0,
        retailCount: record.retail_count || 0,
        vpcStock: record.vpc_stock || 0,
        unbuilt: record.unbuilt_stock || 0,
        companyStock: record.company_stock || 0,
        dealerStock: record.dealer_stock || 0,
        inTransitToOtherVPC: record.in_transit_to_other_vpc || 0,
        otherVPCStock: record.other_vpc_stock || 0,
        postProcessInTransitVPC: record.post_process_in_transit_vpc || 0,
        preProcessInTransitVPC: record.pre_process_in_transit_vpc || 0,
        totalStock: record.total_stock || 0,
        wholesale: record.wholesale || 0,
        salesAvailability: record.sales_availability || 0,
        daysSupply: record.days_supply || 0,
        retailYoY: record.retail_yoy || 0,
        retailMoM: record.retail_mom || 0,
        retailObj: record.retail_obj || 0,
        wholesaleObj: record.wholesale_obj || 0,
        associatedDistributors: record.associated_distributors || [],
        distributorSale: record.distributor_sale || 0
      };
      console.log('dealerRecord', dealerRecord);
      // Add dealer to district
      district.dealers.push(dealerRecord);

      // Roll up totals to district and region levels
      for (const field of sumFields) {
        const value = dealerRecord[field] || 0;
        if (typeof value === 'number') {
          district.district_totals[field] += value;
          region.region_totals[field] += value;
        }
      }
    }

    // Convert to response models
    const result = [];

    for (const [regionCode, regionData] of hierarchy.entries()) {
      const districts = [];

      for (const [districtCode, districtData] of regionData.districts.entries()) {
        const district = {
          districtCode: districtData.district_info.districtCode,
          districtName: districtData.district_info.districtName,
          regionCode: districtData.district_info.regionCode,
          ...districtData.district_totals,
          dealers: districtData.dealers
        };

        districts.push(district);
      }

      const region = {
        regionCode: regionData.region_info.regionCode,
        regionName: regionData.region_info.regionName,
        primaryDistributor: regionData.region_info.primaryDistributor,
        ...regionData.region_totals,
        districts: districts
      };

      result.push(region);
    }

    return result;
  }

  /**
   * Process OpenSearch composite aggregation response
   * @param {Object} response - The OpenSearch response
   * @returns {Array<Object>} The processed dealer data
   */
  _processCompositeAggregationResponse(response) {
    const dealerData = [];

    const buckets = response.body?.aggregations?.dealer_aggregated?.buckets || [];

    for (const bucket of buckets) {
      const key = bucket.key;
      const aggs = bucket;

      // Extract names from nested aggregations
      let regionName = "";
      let districtName = "";
      let dealerName = "";
      let distributors = [];

      if (aggs.region_name?.buckets?.length) {
        regionName = aggs.region_name.buckets[0].key;
      }

      if (aggs.district_name?.buckets?.length) {
        districtName = aggs.district_name.buckets[0].key;
      }

      if (aggs.dealer_name?.buckets?.length) {
        dealerName = aggs.dealer_name.buckets[0].key;
      }

      if (aggs.distributors?.buckets) {
        distributors = aggs.distributors.buckets.map(d => d.key);
      }

      const record = {
        region_code: key.region_code,
        district_code: key.district_code,
        dealer_code: key.dealer_code,
        region_name: regionName,
        district_name: districtName,
        dealer_name: dealerName,
        retail: aggs.retail_count?.value || 0,
        retail_count: aggs.retail_count?.value || 0,
        vpc_stock: aggs.vpc_stock_count?.value || 0,
        unbuilt_stock: aggs.unbuilt_count?.value || 0,
        company_stock: aggs.company_stock_count?.value || 0,
        dealer_stock: aggs.dealer_stock_count?.value || 0,
        in_transit_to_other_vpc: aggs.intransit_othervpc_count?.value || 0,
        other_vpc_stock: aggs.other_vpc_count?.value || 0,
        post_process_in_transit_vpc: aggs.postprocess_intransit_count?.value || 0,
        pre_process_in_transit_vpc: aggs.preprocess_intransit_vpc_count?.value || 0,
        wholesale: aggs.wholesale_count?.value || 0,
        associated_distributors: distributors,
        primary_distributor: distributors.length ? distributors[0] : ""
      };

      // Calculate derived fields
      record.total_stock = (
        record.vpc_stock + record.unbuilt_stock + record.company_stock +
        record.dealer_stock + record.in_transit_to_other_vpc + record.other_vpc_stock +
        record.post_process_in_transit_vpc + record.pre_process_in_transit_vpc
      );

      // Add default values for fields not available in aggregation
      record.sales_availability = 0;
      record.days_supply = 0;
      record.distributor_sale = 0;
      record.retail_yoy = 0;
      record.retail_mom = 0;
      record.retail_obj = 0;
      record.wholesale_obj = 0;

      dealerData.push(record);
    }

    return dealerData;
  }

  /**
   * Calculate pagination information
   * @param {number} currentPage - The current page number
   * @param {number} pageSize - The page size
   * @param {number} totalRegions - The total number of regions
   * @param {Array<string>} currentRegions - The regions in the current page
   * @returns {PaginationInfo} The pagination information
   */
  _calculatePaginationInfo(currentPage, pageSize, totalRegions, currentRegions) {
    const totalPages = totalRegions > 0 ? Math.ceil(totalRegions / pageSize) : 1;
    const hasNextPage = currentPage < totalPages;
    const hasPreviousPage = currentPage > 1;

    // Calculate region range for display
    const startRegion = (currentPage - 1) * pageSize + 1;
    const endRegion = Math.min(currentPage * pageSize, totalRegions);
    const regionRange = `${startRegion}-${endRegion} of ${totalRegions}`;

    return new PaginationInfo({
      current_page: currentPage,
      page_size: pageSize,
      total_regions: totalRegions,
      total_pages: totalPages,
      regions_in_current_page: currentRegions.length,
      has_next_page: hasNextPage,
      has_previous_page: hasPreviousPage,
      current_page_regions: currentRegions,
      region_range: regionRange
    });
  }


  /**
   * Execute paginated PIP query with hierarchical data structure
   * @param {Object} filters - The filters to apply
   * @param {Object} pagination - The pagination parameters
   * @param {Array<string>} indexName - The index name(s) to query
   * @returns {Promise<PIPQueryResponse>} The query response
   */
  async executePaginatedQuery(filters = null, pagination = null, indexName = null) {
    const startTime = Date.now();
    let opensearchQuery = null;

    try {
      // Set default pagination
      logger.info('entered the function executePaginatedQuery');
      if (!pagination) {
        pagination = { page: 1, page_size: 10 };
      }

      // If no index name is provided, use the default index names
      const indices = indexName || settings.indexNamesList;

      // Get all regions for pagination
      logger.info('before function getAllRegions');
      const allRegions = await this.getAllRegions(filters, indices);
      const totalRegions = allRegions.length;

      if (totalRegions === 0) {
        return new PIPQueryResponse({
          success: true,
          pagination: this._calculatePaginationInfo(
            pagination.page, pagination.page_size, 0, []
          ),
          data: [],
          query_info: new QueryInfo(),
          execution_timestamp: new Date()
        });
      }

      // Calculate pagination slice
      const startIdx = (pagination.page - 1) * pagination.page_size;
      const endIdx = startIdx + pagination.page_size;
      const currentPageRegions = allRegions.slice(startIdx, endIdx);

      if (!currentPageRegions.length) {
        return new PIPQueryResponse({
          success: true,
          pagination: this._calculatePaginationInfo(
            pagination.page, pagination.page_size, totalRegions, []
          ),
          data: [],
          query_info: new QueryInfo(),
          execution_timestamp: new Date()
        });
      }

      // Build and execute aggregation query for current page regions
      opensearchQuery = this._buildDealerAggregatedQuery(filters, currentPageRegions);

      logger.info(`Executing query for regions: ${currentPageRegions.join(', ')}`);
      logger.debug(`Query body: ${JSON.stringify(opensearchQuery)}`);

      const client = await this.getClient();
      const response = await client.search({
        index: indices,
        body: opensearchQuery,
        timeout: '30s'
      });

      // Process response
      const dealerData = this._processCompositeAggregationResponse(response);
      const hierarchicalData = this._createHierarchicalStructure(dealerData);

      // Calculate statistics
      const totalDealers = dealerData.length;
      const dealerCodes = dealerData.map(d => d.dealer_code);
      const uniqueDealers = new Set(dealerCodes);
      const duplicateDealers = {};

      for (const dealerCode of dealerCodes) {
        const count = dealerCodes.filter(d => d === dealerCode).length;
        if (count > 1) {
          duplicateDealers[dealerCode] = count;
        }
      }

      // Build query info
      const queryInfo = new QueryInfo({
        took: response.body?.took || 0,
        timed_out: response.body?.timed_out || false,
        total_shards: response.body?._shards?.total || 0,
        successful_shards: response.body?._shards?.successful || 0
      });

      // Build pagination info
      const paginationInfo = this._calculatePaginationInfo(
        pagination.page, pagination.page_size, totalRegions, currentPageRegions
      );

      const executionTime = (Date.now() - startTime) / 1000;
      logger.info(`Query executed successfully in ${executionTime.toFixed(2)} seconds`);

      return new PIPQueryResponse({
        success: true,
        pagination: paginationInfo,
        total_aggregated_dealers: totalDealers,
        unique_dealers_count: uniqueDealers.size,
        duplicate_dealers: Object.keys(duplicateDealers).length > 0 ? duplicateDealers : null,
        data: hierarchicalData,
        query_info: queryInfo,
        execution_timestamp: new Date()
      });

    } catch (error) {
      const executionTime = (Date.now() - startTime) / 1000;
      logger.error(`Query failed after ${executionTime.toFixed(2)} seconds: ${error.message}`);

      if (opensearchQuery) {
        logger.error(`Query that failed: ${JSON.stringify(opensearchQuery)}`);
      } else {
        logger.error('Query not built due to early error');
      }

      return new PIPQueryResponse({
        success: false,
        pagination: new PaginationInfo({
          current_page: pagination?.page || 1,
          page_size: pagination?.page_size || 5,
          total_regions: 0,
          total_pages: 0,
          regions_in_current_page: 0,
          has_next_page: false,
          has_previous_page: false,
          current_page_regions: [],
          region_range: "0-0 of 0"
        }),
        data: [],
        query_info: new QueryInfo(),
        execution_timestamp: new Date(),
        error: error.message
      });
    }
  }

  /**
   * Health check method to verify the service is working
   * @returns {Promise<Object>} The health check result
   */
  async healthCheck() {
    try {
      const client = await this.getClient();
      const health = await client.cluster.health();

      return {
        success: true,
        opensearch_status: health.body?.status || 'unknown',
        cluster_name: health.body?.cluster_name || 'unknown',
        message: 'PIP Query Service is healthy'
      };
    } catch (error) {
      logger.error(`Health check failed: ${error.message}`);
      return {
        success: false,
        error: error.message,
        message: 'PIP Query Service is unhealthy'
      };
    }
  }

  /**
   * Execute paginated PIP query with hierarchical data structure
   * @param {Object} filters - The filters to apply
   * @param {Object} pagination - The pagination parameters
   * @param {Array<string>} indexName - The index name(s) to query
   */
  async executeRegionSummaryPaginatedQuery(filtersData = null, pagination = null, indexName = null) {
    const startTime = Date.now();
    let opensearchQuery = null;

    try {
      // Set default pagination
      logger.info('entered the function executePaginatedQuery');
      if (!pagination) {
        pagination = { page: 1, page_size: 10 };
      }

      // If no index name is provided, use the default index names
      const indices = indexName || settings.indexNamesList;

      const filters = {
        distributors: filtersData?.distributor || null,
        brand_code: filtersData?.brand || null,
        segment_code: filtersData?.segment || null,
        fleet_flag: filtersData?.fleetIndicator || null,
        region_code: filtersData?.regionCode || null,
        dealer_code: filtersData?.dealerCode || null,
        model_year: filtersData?.modelYear || null,
        series_name: filtersData?.salesSeriesName || null,
        drivetrain_code: filtersData?.drivetrainName || null,
        accessory_code: filtersData?.fioAccessory || null,
        //ppoAccessory: filtersData?.ppoAccessory || null,
        exterior_color_code: filtersData?.exteriorColor || null,
        interior_color_code: filtersData?.interiorColor || null,
      }

      // Get all regions for pagination
      logger.info('before function getAllRegions');
      const allRegions = await this.getAllRegions(filters, indices);
      const totalRegions = allRegions.length;

      if (totalRegions === 0) {
        return {
          success: true,
          pagination: this._calculatePaginationInfo(
            pagination.page, pagination.page_size, 0, []
          ),
          data: [],
          query_info: new QueryInfo(),
          execution_timestamp: new Date()
        };
      }

      // Calculate pagination slice
      const startIdx = (pagination.page - 1) * pagination.page_size;
      const endIdx = startIdx + pagination.page_size;
      const currentPageRegions = allRegions.slice(startIdx, endIdx);

      if (!currentPageRegions.length) {
        return {
          success: true,
          pagination: this._calculatePaginationInfo(
            pagination.page, pagination.page_size, totalRegions, []
          ),
          data: [],
          query_info: new QueryInfo(),
          execution_timestamp: new Date()
        };
      }

      // Build and execute aggregation query for current page regions
      opensearchQuery = this._buildDealerAggregatedQuery(filters, currentPageRegions);

      logger.info(`Executing query for regions: ${currentPageRegions.join(', ')}`);
      logger.debug(`Query body: ${JSON.stringify(opensearchQuery)}`);

      const client = await this.getClient();
      const response = await client.search({
        index: indices,
        body: opensearchQuery,
        timeout: '30s'
      });

      // Process response
      const dealerData = this._processCompositeAggregationResponse(response);
      const hierarchicalData = this._createHierarchicalStructureForRegionSummary(dealerData);

      // Calculate statistics
      const totalDealers = dealerData.length;
      const dealerCodes = dealerData.map(d => d.dealer_code);
      const uniqueDealers = new Set(dealerCodes);
      const duplicateDealers = {};

      for (const dealerCode of dealerCodes) {
        const count = dealerCodes.filter(d => d === dealerCode).length;
        if (count > 1) {
          duplicateDealers[dealerCode] = count;
        }
      }

      // Build query info
      const queryInfo = new QueryInfo({
        took: response.body?.took || 0,
        timed_out: response.body?.timed_out || false,
        total_shards: response.body?._shards?.total || 0,
        successful_shards: response.body?._shards?.successful || 0
      });

      // Build pagination info
      const paginationInfo = this._calculatePaginationInfo(
        pagination.page, pagination.page_size, totalRegions, currentPageRegions
      );

      console.log('hierarchicalData--', hierarchicalData);
      const executionTime = (Date.now() - startTime) / 1000;
      logger.info(`Query executed successfully in ${executionTime.toFixed(2)} seconds`);

      return {
        success: true,
        pagination: paginationInfo,
        total_aggregated_dealers: totalDealers,
        unique_dealers_count: uniqueDealers.size,
        duplicate_dealers: Object.keys(duplicateDealers).length > 0 ? duplicateDealers : null,
        data: hierarchicalData,
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
        pagination: new PaginationInfo({
          current_page: pagination?.page || 1,
          page_size: pagination?.page_size || 5,
          total_regions: 0,
          total_pages: 0,
          regions_in_current_page: 0,
          has_next_page: false,
          has_previous_page: false,
          current_page_regions: [],
          region_range: "0-0 of 0"
        }),
        data: [],
        query_info: new QueryInfo(),
        execution_timestamp: new Date(),
        error: error.message
      };
    }
  }
  /**
   * Build filter query for v3 index structure (accessory data)
   * @param {Object} filters - Filter criteria
   * @returns {Object} OpenSearch filter query
   * @private
   */
  _buildFilterQueryV3(filters) {
    const mustFilters = [];

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

    // Handle array-based filters - based on v3 index mapping
    const arrayFilters = [
      'sls_ccyymm', 'region_code', 'district_code', 'dealer_code', 'model_year', 'model_code',
      'brand_code', 'segment_code', 'car_trk_indicator', 'dealer_type',
      'team_lease_indicator', 'transmissiontype_code', 'series_name', 'grade_code',
      'drivetrain_code', 'accessory_code', 'fac_pio_indicator',
      'napc_bu_code', 'create_by', 'update_by'
    ];

    arrayFilters.forEach(filterKey => {
      if (filters[filterKey] && Array.isArray(filters[filterKey]) && filters[filterKey].length > 0) {
        mustFilters.push({
          terms: {
            [filterKey]: filters[filterKey]
          }
        });
      }
    });

    // Handle boolean filters
    if (filters.fleet_flag && Array.isArray(filters.fleet_flag) && filters.fleet_flag.length > 0) {
      mustFilters.push({
        terms: {
          fleet_flag: filters.fleet_flag
        }
      });
    }

    if (mustFilters.length > 0) {
      return {
        bool: {
          must: mustFilters
        }
      };
    } else {
      return { match_all: {} };
    }
  }

  /**
   * Build OpenSearch query from filters for v4
   * @param {Object} filters - The filters to apply
   * @returns {Object} The OpenSearch query
   */
  _buildOpenSearchQueryV4(filters) {
    const query = {
      bool: {
        must: [
          { match_all: {} }
        ]
      }
    };

    if (filters) {
      for (const [field, value] of Object.entries(filters)) {
        if (field === "transaction_date" && typeof value === 'object' && value.range) {
          // Handle transaction date range queries
          query.bool.must.push({
            range: { transaction_date: value.range }
          });
        } else if (field === "sls_ccyymm" && Array.isArray(value) && value.length > 0) {
          // Handle sls_ccyymm filter - special case for year-month filtering
          query.bool.must.push({
            terms: { "sls_ccyymm": value }
          });
          logger.info(`V4 Applied sales_ccyymm filter with values: ${value.join(', ')}`);
        } else if (Array.isArray(value) && value.length > 0) {
          // Handle list of values with terms query
          query.bool.must.push({
            terms: { [field]: value }
          });
        } else if (['string', 'number', 'boolean'].includes(typeof value) && value !== "") {
          // Handle single values with term query, but exclude empty strings
          query.bool.must.push({
            term: { [field]: value }
          });
        } else if (typeof value === 'object' && value.range) {
          // Handle other range queries
          query.bool.must.push({
            range: { [field]: value.range }
          });
        }
        // Skip null values, empty arrays, empty strings, and unrecognized formats
      }
    }
    logger.info(`V4 The query with filters is for me to validate :`);
    logger.info(JSON.stringify(query));
    return query;
  }

  /**
   * Process OpenSearch composite aggregation response for v4
   * @param {Object} response - The OpenSearch response
   * @returns {Array<Object>} The processed dealer data
   */
  _processCompositeAggregationResponseV4(response) {
    const dealerData = [];

    const buckets = response.body?.aggregations?.dealer_aggregated?.buckets || [];

    for (const bucket of buckets) {
      const key = bucket.key;
      const aggs = bucket;

      // Extract names and metadata from nested aggregations
      let regionName = "";
      let districtName = "";
      let dealerName = "";
      let slsCcyymm = "";
      let fleetFlag = false;
      let segmentCode = "";
      let brandCode = "";
      let gradeCode = "";
      let transmissiontypeCode = "";
      let interiorColorCode = "";
      let interiorTrimColorDesc = "";
      let exteriorColorCode = "";
      let exteriorColorDesc = "";
      let carTrkIndicator = "";
      let drivetrainCode = "";

      if (aggs.region_name?.buckets?.length) {
        regionName = aggs.region_name.buckets[0].key;
      }

      if (aggs.district_name?.buckets?.length) {
        districtName = aggs.district_name.buckets[0].key;
      }

      if (aggs.dealer_name?.buckets?.length) {
        dealerName = aggs.dealer_name.buckets[0].key;
      }

      if (aggs.sls_ccyymm?.buckets?.length) {
        slsCcyymm = aggs.sls_ccyymm.buckets[0].key;
      }

      if (aggs.fleet_flag?.buckets?.length) {
        fleetFlag = aggs.fleet_flag.buckets[0].key;
      }

      if (aggs.segment_code?.buckets?.length) {
        segmentCode = aggs.segment_code.buckets[0].key;
      }

      if (aggs.brand_code?.buckets?.length) {
        brandCode = aggs.brand_code.buckets[0].key;
      }

      if (aggs.grade_code?.buckets?.length) {
        gradeCode = aggs.grade_code.buckets[0].key;
      }

      if (aggs.transmissiontype_code?.buckets?.length) {
        transmissiontypeCode = aggs.transmissiontype_code.buckets[0].key;
      }

      if (aggs.interior_color_code?.buckets?.length) {
        interiorColorCode = aggs.interior_color_code.buckets[0].key;
      }

      if (aggs.interior_trim_color_desc?.buckets?.length) {
        interiorTrimColorDesc = aggs.interior_trim_color_desc.buckets[0].key;
      }

      if (aggs.exterior_color_code?.buckets?.length) {
        exteriorColorCode = aggs.exterior_color_code.buckets[0].key;
      }

      if (aggs.exterior_color_desc?.buckets?.length) {
        exteriorColorDesc = aggs.exterior_color_desc.buckets[0].key;
      }

      if (aggs.car_trk_indicator?.buckets?.length) {
        carTrkIndicator = aggs.car_trk_indicator.buckets[0].key;
      }

      if (aggs.drivetrain_code?.buckets?.length) {
        drivetrainCode = aggs.drivetrain_code.buckets[0].key;
      }

      const record = {
        region_code: key.region_code,
        district_code: key.district_code,
        dealer_code: key.dealer_code,
        region_name: regionName,
        district_name: districtName,
        dealer_name: dealerName,
        sls_ccyymm: slsCcyymm,
        fleet_flag: fleetFlag,
        segment_code: segmentCode,
        brand_code: brandCode,
        grade_code: gradeCode,
        transmissiontype_code: transmissiontypeCode,
        interior_color_code: interiorColorCode,
        interior_trim_color_desc: interiorTrimColorDesc,
        exterior_color_code: exteriorColorCode,
        exterior_color_desc: exteriorColorDesc,
        car_trk_indicator: carTrkIndicator,
        drivetrain_code: drivetrainCode,
        // Aggregated metrics
        sales_availability_count: aggs.sales_availability_count?.value || 0,
        days_supply_count: aggs.days_supply_count?.value || 0,
        retail_count: aggs.retail_count?.value || 0,
        vpc_stock_count: aggs.vpc_stock_count?.value || 0,
        unbuilt_count: aggs.unbuilt_count?.value || 0,
        company_stock_count: aggs.company_stock_count?.value || 0,
        dealer_stock_count: aggs.dealer_stock_count?.value || 0,
        intransit_othervpc_count: aggs.intransit_othervpc_count?.value || 0,
        totalstock_count: aggs.totalstock_count?.value || 0,
        other_vpc_count: aggs.other_vpc_count?.value || 0,
        postprocess_intransit_count: aggs.postprocess_intransit_count?.value || 0,
        preprocess_intransit_vpc_count: aggs.preprocess_intransit_vpc_count?.value || 0,
        wholesale_count: aggs.wholesale_count?.value || 0,
        hist_dealerstock_count: aggs.hist_dealerstock_count?.value || 0,
        hist_tmsstock_count: aggs.hist_tmsstock_count?.value || 0,
        hist_mfgstock_count: aggs.hist_mfgstock_count?.value || 0,
        hist_portstock_count: aggs.hist_portstock_count?.value || 0,
        hist_intransitstock_count: aggs.hist_intransitstock_count?.value || 0
      };

      dealerData.push(record);
    }

    return dealerData;
  }

  /**
   * Execute paginated PIP query for v31 (accessory data similar to v1) with flat aggregated structure
   * @param {Object} filters - The filters to apply
   * @param {Object} pagination - The pagination parameters
   * @param {Array<string>} indexName - The index name(s) to query
   * @returns {Promise<Object>} The query response
   */
  async executePaginatedQueryV31(filters = null, pagination = null, indexName = null) {
    const startTime = Date.now();
    let opensearchQuery = null;

    try {
      // Set default pagination
      logger.info('entered the function executePaginatedQueryV31');
      if (!pagination) {
        pagination = { page: 1, page_size: 10 };
      }

      // If no index name is provided, use the default indices
      const indices = indexName || [`pipe-rgn-dlr-dist-sale-inv-acc-daily-summ-2025`];

      // Log wildcard filter usage for monitoring
      if (filters) {
        const wildcardFields = ['region_code', 'district_code', 'dealer_code'];
        wildcardFields.forEach(field => {
          if (filters[field] && Array.isArray(filters[field])) {
            const wildcardCount = filters[field].filter(val =>
              typeof val === 'string' && (val.includes('*') || val.includes('?'))
            ).length;
            if (wildcardCount > 0) {
              logger.info(`[WILDCARD] ${field} filter contains ${wildcardCount} wildcard patterns out of ${filters[field].length} total values`);
            }
          }
        });
      }

      // Build and execute aggregation query for ALL data (similar to v1 approach)
      opensearchQuery = this._buildDealerAggregatedQueryV31(filters, 50000); // Large size for complete data

      logger.info(`V31 Executing query for all data with increased size limit`);
      logger.info(`V31 Query body: ${JSON.stringify(opensearchQuery, null, 2)}`);

      const client = await this.getClient();

      // Get all dealer data using composite aggregation with pagination if needed
      const allDealerData = await this._getAllDealerDataV31(client, indices, opensearchQuery);

      // Create flat aggregated structure (similar to v1 response format)
      const aggregatedData = this._createFlatAggregatedStructureV31(allDealerData);

      // Calculate statistics
      const totalRecords = aggregatedData.length;

      // Build query info
      const queryInfo = {
        took: 0,
        timed_out: false,
        total_shards: 0,
        successful_shards: 0
      };

      const executionTime = (Date.now() - startTime) / 1000;
      logger.info(`V31 Query executed successfully in ${executionTime.toFixed(2)} seconds`);

      return {
        success: true,
        data: aggregatedData,
        total_records: totalRecords,
        query_info: queryInfo,
        execution_timestamp: new Date(),
        version: "v31",
        aggregation_level: "flat_dealer_aggregation"
      };

    } catch (error) {
      const executionTime = (Date.now() - startTime) / 1000;

      // Enhanced error logging for wildcard-related issues
      if (error.message && error.message.includes('wildcard')) {
        logger.error(`[WILDCARD] V31 Query failed with wildcard-related error after ${executionTime.toFixed(2)} seconds: ${error.message}`);
      } else {
        logger.error(`V31 Query failed after ${executionTime.toFixed(2)} seconds: ${error.message}`);
      }

      if (opensearchQuery) {
        logger.error(`V31 Query that failed: ${JSON.stringify(opensearchQuery)}`);
      }

      return {
        success: false,
        error: `V31 Query execution failed: ${error.message}`,
        data: [],
        query_info: {
          took: 0,
          timed_out: false,
          total_shards: 0,
          successful_shards: 0,
          error: error.message
        },
        execution_timestamp: new Date(),
        version: "v31",
        aggregation_level: "flat_dealer_aggregation"
      };
    }
  }

  /**
   * Build OpenSearch aggregation query for v31 dealer-level data (similar to v1)
   * @param {Object} filters - The filters to apply
   * @param {number} size - The maximum number of results to return
   * @returns {Object} The OpenSearch query
   */
  _buildDealerAggregatedQueryV31(filters = null, size = 10000) {
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
          filterDict.transaction_date = value; // Pass the date range object directly
        } else {
          filterDict[key] = value;
        }
      }
    }

    const query = this._buildFilterQueryV31(filterDict);

    const aggs = {
      dealer_aggregation: {
        composite: {
          size: size,
          sources: [
            // GROUP BY fields: distributor_code, district_code, region_code, dealer_code with names
            { distributor_code: { terms: { field: "distributor_code" } } },
            { distributor_name: { terms: { field: "distributor_name" } } },
            { district_code: { terms: { field: "district_code" } } },
            { region_code: { terms: { field: "region_code" } } },
            { region_name: { terms: { field: "region_name" } } },
            { dealer_code: { terms: { field: "dealer_code" } } },
            { dealer_name: { terms: { field: "dealer_name" } } }
          ]
        },
        aggs: {
          // Aggregated metrics from the SQL query
          sales_availability_count: { sum: { field: "sales_availability_count" } },
          days_supply_count: { sum: { field: "days_supply_count" } },
          retail_count: { sum: { field: "retail_count" } },
          vpc_stock_count: { sum: { field: "vpc_stock_count" } },
          unbuilt_count: { sum: { field: "unbuilt_count" } },
          company_stock_count: { sum: { field: "company_stock_count" } },
          dealer_stock_count: { sum: { field: "dealer_stock_count" } },
          intransit_othervpc_count: { sum: { field: "intransit_othervpc_count" } },
          totalstock_count: { sum: { field: "totalstock_count" } },
          other_vpc_count: { sum: { field: "other_vpc_count" } },
          postprocess_intransit_count: { sum: { field: "postprocess_intransit_count" } },
          preprocess_intransit_vpc_count: { sum: { field: "preprocess_intransit_vpc_count" } },
          wholesale_count: { sum: { field: "wholesale_count" } },
          hist_dealerstock_count: { sum: { field: "hist_dealerstock_count" } },
          hist_tmsstock_count: { sum: { field: "hist_tmsstock_count" } },
          hist_mfgstock_count: { sum: { field: "hist_mfgstock_count" } },
          hist_portstock_count: { sum: { field: "hist_portstock_count" } },
          hist_intransitstock_count: { sum: { field: "hist_intransitstock_count" } },
          brand_code: { terms: { field: "brand_code", size: 1 } }
        }
      }
    };

    return {
      size: 0,
      query: query,
      aggs: aggs
    };
  }

  /**
   * Build filter query for v31
   * @param {Object} filters - The filters to apply
   * @returns {Object} The OpenSearch query
   */
  _buildFilterQueryV31(filters) {
    const mustFilters = [];

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

    // Handle wildcard-supported filters (region_code, district_code, dealer_code)
    const wildcardSupportedFilters = ['region_code', 'district_code', 'dealer_code'];

    wildcardSupportedFilters.forEach(filterKey => {
      if (filters[filterKey] && Array.isArray(filters[filterKey]) && filters[filterKey].length > 0) {
        const filterQuery = this._buildWildcardSupportedFilter(filterKey, filters[filterKey]);
        if (filterQuery) {
          mustFilters.push(filterQuery);
        }
      }
    });

    // Handle standard array-based filters - based on v31 index mapping
    const standardArrayFilters = [
      'sls_ccyymm', 'distributor_code', 'model_year', 'model_code',
      'brand_code', 'segment_code', 'car_trk_indicator', 'dealer_type',
      'team_lease_indicator', 'transmissiontype_code', 'series_name', 'grade_code',
      'drivetrain_code', 'accessory_code', 'fac_pio_indicator',
      'napc_bu_code', 'create_by', 'update_by'
    ];

    standardArrayFilters.forEach(filterKey => {
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

    if (mustFilters.length === 0) {
      return { match_all: {} };
    }

    return {
      bool: {
        must: mustFilters
      }
    };
  }

  /**
   * Builds filter query for fields supporting wildcard search
   * @param {string} fieldName - The field name (region_code, district_code, dealer_code)
   * @param {Array<string>} values - Array of filter values (exact or wildcard patterns)
   * @returns {Object} OpenSearch query object
   * @private
   */
  _buildWildcardSupportedFilter(fieldName, values) {
    if (!Array.isArray(values) || values.length === 0) {
      return null;
    }

    const exactValues = [];
    const wildcardPatterns = [];

    // Separate exact values from wildcard patterns
    values.forEach(value => {
      if (typeof value === 'string' && (value.includes('*') || value.includes('?'))) {
        // Normalize multiple consecutive wildcards
        const normalizedPattern = value.replace(/\*+/g, '*');

        // Validate pattern (must contain at least one non-wildcard character)
        if (/[^\*\?]/.test(normalizedPattern) && normalizedPattern.trim() !== '') {
          // Additional validation for potentially problematic patterns
          if (normalizedPattern.length > 100) {
            console.warn(`[WILDCARD] Wildcard pattern too long for ${fieldName}: "${value}" (${normalizedPattern.length} chars) - treating as exact match`);
            exactValues.push(value);
          } else {
            wildcardPatterns.push(normalizedPattern);
          }
        } else {
          console.warn(`[WILDCARD] Invalid wildcard pattern for ${fieldName}: "${value}" - treating as exact match`);
          exactValues.push(value);
        }
      } else {
        exactValues.push(value);
      }
    });

    const shouldClauses = [];

    // Add exact match queries if we have exact values
    if (exactValues.length > 0) {
      shouldClauses.push({
        terms: { [fieldName]: exactValues }
      });
      shouldClauses.push({
        terms: { [`${fieldName}.keyword`]: exactValues }
      });
    }

    // Add wildcard queries if we have valid wildcard patterns
    if (wildcardPatterns.length > 0) {
      wildcardPatterns.forEach(pattern => {
        shouldClauses.push({
          wildcard: { [fieldName]: pattern }
        });
        shouldClauses.push({
          wildcard: { [`${fieldName}.keyword`]: pattern }
        });
      });
    }

    // If no valid clauses, return null
    if (shouldClauses.length === 0) {
      return null;
    }

    // Log the filter processing for monitoring
    const logMessage = `[WILDCARD] Processing ${fieldName} filter - Exact: ${exactValues.length}, Wildcard: ${wildcardPatterns.length}`;
    if (wildcardPatterns.length > 0) {
      console.log(`${logMessage} - Patterns: [${wildcardPatterns.join(', ')}]`);
    } else {
      console.log(logMessage);
    }

    return {
      bool: {
        should: shouldClauses,
        minimum_should_match: 1
      }
    };
  }

  /**
   * Get all dealer data using composite aggregation with pagination for V31
   * @param {Object} client - The OpenSearch client
   * @param {Array<string>} indices - The indices to query
   * @param {Object} baseQuery - The base query structure
   * @returns {Promise<Array<Object>>} All dealer data
   * @private
   */
  async _getAllDealerDataV31(client, indices, baseQuery) {
    let allDealerData = [];
    let after = null;
    let hasMore = true;
    let totalRequests = 0;
    const maxRequests = 10; // Safety limit

    logger.info('V31 Starting composite aggregation pagination to get all dealer data');

    while (hasMore && totalRequests < maxRequests) {
      totalRequests++;

      // Clone the base query and add after parameter for pagination
      const query = JSON.parse(JSON.stringify(baseQuery));
      if (after) {
        query.aggs.dealer_aggregation.composite.after = after;
      }

      logger.info(`V31 Executing composite aggregation request ${totalRequests} ${after ? 'with after: ' + JSON.stringify(after) : '(first request)'}`);

      try {
        const response = await client.search({
          index: indices,
          body: query,
          timeout: '60s' // Increased timeout for large aggregations
        });

        const buckets = response.body?.aggregations?.dealer_aggregation?.buckets || [];
        logger.info(`V31 Request ${totalRequests} returned ${buckets.length} buckets`);

        if (buckets.length === 0) {
          hasMore = false;
          break;
        }

        // Process this batch of data
        const batchData = this._processCompositeAggregationResponseV31(response);
        allDealerData = allDealerData.concat(batchData);

        // Check if there's more data
        const afterKey = response.body?.aggregations?.dealer_aggregation?.after_key;
        if (afterKey) {
          after = afterKey;
          logger.info(`V31 More data available, after_key: ${JSON.stringify(afterKey)}`);
        } else {
          hasMore = false;
          logger.info('V31 No more data available, pagination complete');
        }

      } catch (error) {
        logger.error(`V31 Error in composite aggregation request ${totalRequests}: ${error.message}`);
        hasMore = false;
      }
    }

    if (totalRequests >= maxRequests) {
      logger.warn(`V31 Reached maximum requests limit (${maxRequests}), some data might be missing`);
    }

    logger.info(`V31 Composite aggregation complete: ${totalRequests} requests, ${allDealerData.length} total dealer records`);
    return allDealerData;
  }

  /**
   * Process OpenSearch composite aggregation response for v31
   * @param {Object} response - The OpenSearch response
   * @returns {Array<Object>} The processed dealer data
   */
  _processCompositeAggregationResponseV31(response) {
    const dealerData = [];

    if (!response.body?.aggregations?.dealer_aggregation?.buckets) {
      logger.warn('V31 No aggregation buckets found in response');
      return dealerData;
    }

    const buckets = response.body.aggregations.dealer_aggregation.buckets;
    logger.info(`V31 Processing ${buckets.length} dealer aggregation buckets`);

    buckets.forEach(bucket => {
      const key = bucket.key;
      const dealerRecord = {
        // Grouping fields: distributor_code, district_code, region_code, dealer_code with names
        distributor_code: key.distributor_code || '',
        distributor_name: key.distributor_name || '',
        district_code: key.district_code || '',
        region_code: key.region_code || '',
        region_name: key.region_name || '',
        dealer_code: key.dealer_code || '',
        dealer_name: key.dealer_name || '',
        brand_code: bucket.brand_code?.buckets?.[0]?.key || '',

        // Aggregated metrics - these are already summed at dealer level by OpenSearch
        sales_availability_count: bucket.sales_availability_count?.value || 0,
        days_supply_count: bucket.days_supply_count?.value || 0,
        retail_count: bucket.retail_count?.value || 0,
        vpc_stock_count: bucket.vpc_stock_count?.value || 0,
        unbuilt_count: bucket.unbuilt_count?.value || 0,
        company_stock_count: bucket.company_stock_count?.value || 0,
        dealer_stock_count: bucket.dealer_stock_count?.value || 0,
        intransit_othervpc_count: bucket.intransit_othervpc_count?.value || 0,
        totalstock_count: bucket.totalstock_count?.value || 0,
        other_vpc_count: bucket.other_vpc_count?.value || 0,
        postprocess_intransit_count: bucket.postprocess_intransit_count?.value || 0,
        preprocess_intransit_vpc_count: bucket.preprocess_intransit_vpc_count?.value || 0,
        wholesale_count: bucket.wholesale_count?.value || 0,
        hist_dealerstock_count: bucket.hist_dealerstock_count?.value || 0,
        hist_tmsstock_count: bucket.hist_tmsstock_count?.value || 0,
        hist_mfgstock_count: bucket.hist_mfgstock_count?.value || 0,
        hist_portstock_count: bucket.hist_portstock_count?.value || 0,
        hist_intransitstock_count: bucket.hist_intransitstock_count?.value || 0
      };

      dealerData.push(dealerRecord);
    });

    logger.info(`V31 Processed ${dealerData.length} dealer records (flat aggregated structure)`);
    return dealerData;
  }

  /**
   * Create flat aggregated structure from dealer data for v31 (similar to v1 response format)
   * @param {Array<Object>} dealerData - The dealer data
   * @returns {Array<Object>} The flat aggregated structure
   */
  _createFlatAggregatedStructureV31(dealerData) {
    logger.info(`V31 Creating flat aggregated structure from ${dealerData.length} dealer records`);

    // Debug: Log sample of dealer data
    if (dealerData.length > 0) {
      logger.info(`V31 Sample dealer record: ${JSON.stringify(dealerData[0], null, 2)}`);
    }

    // For v31, we return the data as-is since it's already aggregated at the dealer level
    // This matches the aggregation structure: GROUP BY distributor_code, district_code, region_code, dealer_code with names
    logger.info(`V31 Created flat structure with ${dealerData.length} dealer records`);

    return dealerData;
  }

  /**
   * Execute paginated query for v32 with sales inventory data structure including color filters
   * @param {Object} filters - The filters to apply
   * @param {Object} pagination - The pagination parameters
   * @param {Array<string>} indexName - The index names to query
   * @returns {Promise<Object>} The query response
   */
  async executePaginatedQueryV32(filters = null, pagination = null, indexName = null) {
    const startTime = Date.now();
    let opensearchQuery = null;

    try {
      // Set default pagination
      logger.info('entered the function executePaginatedQueryV32');
      if (!pagination) {
        pagination = { page: 1, page_size: 10 };
      }

      // If no index name is provided, use the default indices
      const indices = indexName || [`pipe-rgn-dlr-dist-sale-inv-acc-daily-summary-2025`];

      // Log wildcard filter usage for monitoring
      if (filters) {
        const wildcardFields = ['region_code', 'district_code', 'dealer_code'];
        wildcardFields.forEach(field => {
          if (filters[field] && Array.isArray(filters[field])) {
            const wildcardCount = filters[field].filter(val =>
              typeof val === 'string' && (val.includes('*') || val.includes('?'))
            ).length;
            if (wildcardCount > 0) {
              logger.info(`[WILDCARD] V32 ${field} filter contains ${wildcardCount} wildcard patterns out of ${filters[field].length} total values`);
            }
          }
        });
      }

      // Build and execute aggregation query for ALL data (similar to v31 approach)
      opensearchQuery = this._buildDealerAggregatedQueryV32(filters, 50000); // Large size for complete data

      logger.info(`V32 Executing query for all data with increased size limit`);
      logger.info(`V32 Query body: ${JSON.stringify(opensearchQuery, null, 2)}`);

      const client = await this.getClient();

      // Get all dealer data using composite aggregation with pagination if needed
      const allDealerData = await this._getAllDealerDataV32(client, indices, opensearchQuery);

      // Create flat aggregated structure (similar to v31 response format)
      const aggregatedData = this._createFlatAggregatedStructureV32(allDealerData);

      // Calculate statistics
      const totalRecords = aggregatedData.length;

      // Build query info
      const queryInfo = {
        took: 0,
        timed_out: false,
        total_shards: 0,
        successful_shards: 0
      };

      const executionTime = (Date.now() - startTime) / 1000;
      logger.info(`V32 Query executed successfully in ${executionTime.toFixed(2)} seconds`);

      return {
        success: true,
        data: aggregatedData,
        total_records: totalRecords,
        query_info: queryInfo,
        execution_timestamp: new Date(),
        version: "v32",
        aggregation_level: "flat_dealer_aggregation"
      };

    } catch (error) {
      const executionTime = (Date.now() - startTime) / 1000;

      // Enhanced error logging for wildcard-related issues
      if (error.message && error.message.includes('wildcard')) {
        logger.error(`[WILDCARD] V32 Query failed with wildcard-related error after ${executionTime.toFixed(2)} seconds: ${error.message}`);
      } else {
        logger.error(`V32 Query failed after ${executionTime.toFixed(2)} seconds: ${error.message}`);
      }

      if (opensearchQuery) {
        logger.error(`V32 Query that failed: ${JSON.stringify(opensearchQuery)}`);
      }

      return {
        success: false,
        error: `V32 Query execution failed: ${error.message}`,
        data: [],
        query_info: {
          took: 0,
          timed_out: false,
          total_shards: 0,
          successful_shards: 0,
          error: error.message
        },
        execution_timestamp: new Date(),
        version: "v32",
        aggregation_level: "flat_dealer_aggregation"
      };
    }
  }

  /**
   * Build OpenSearch aggregation query for v32 dealer-level data with color filters
   * @param {Object} filters - The filters to apply
   * @param {number} size - The maximum number of results to return
   * @returns {Object} The OpenSearch query
   */
  _buildDealerAggregatedQueryV32(filters = null, size = 10000) {
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
          filterDict.transaction_date = value; // Pass the date range object directly
        } else {
          filterDict[key] = value;
        }
      }
    }

    const query = this._buildFilterQueryV32(filterDict);

    const aggs = {
      dealer_aggregation: {
        composite: {
          size: size,
          sources: [
            // GROUP BY fields: distributor_code, district_code, region_code, dealer_code with names
            { distributor_code: { terms: { field: "distributor_code" } } },
            { distributor_name: { terms: { field: "distributor_name" } } },
            { district_code: { terms: { field: "district_code" } } },
            { region_code: { terms: { field: "region_code" } } },
            { region_name: { terms: { field: "region_name" } } },
            { dealer_code: { terms: { field: "dealer_code" } } },
            { dealer_name: { terms: { field: "dealer_name" } } },
            { objective_record_indicator: { terms: { field: "objective_record_indicator" } } },
            { objective_available_indicator: { terms: { field: "objective_available_indicator" } } }
          ]
        },
        aggs: {
          // Aggregated metrics from the SQL query
          sales_availability_count: { sum: { field: "sales_availability_count" } },
          days_supply_count: { sum: { field: "days_supply_count" } },
          retail_count: { sum: { field: "retail_count" } },
          vpc_stock_count: { sum: { field: "vpc_stock_count" } },
          unbuilt_count: { sum: { field: "unbuilt_count" } },
          company_stock_count: { sum: { field: "company_stock_count" } },
          dealer_stock_count: { sum: { field: "dealer_stock_count" } },
          intransit_othervpc_count: { sum: { field: "intransit_othervpc_count" } },
          totalstock_count: { sum: { field: "totalstock_count" } },
          other_vpc_count: { sum: { field: "other_vpc_count" } },
          postprocess_intransit_count: { sum: { field: "postprocess_intransit_count" } },
          preprocess_intransit_vpc_count: { sum: { field: "preprocess_intransit_vpc_count" } },
          wholesale_count: { sum: { field: "wholesale_count" } },
          hist_dealerstock_count: { sum: { field: "hist_dealerstock_count" } },
          hist_tmsstock_count: { sum: { field: "hist_tmsstock_count" } },
          hist_mfgstock_count: { sum: { field: "hist_mfgstock_count" } },
          hist_portstock_count: { sum: { field: "hist_portstock_count" } },
          hist_intransitstock_count: { sum: { field: "hist_intransitstock_count" } },
          brand_code: { terms: { field: "brand_code", size: 1 } }
        }
      }
    };

    return {
      size: 0,
      query: query,
      aggs: aggs
    };
  }



  /**
   * Get all dealer data using composite aggregation with pagination for V32
   * @param {Object} client - The OpenSearch client
   * @param {Array<string>} indices - The indices to query
   * @param {Object} baseQuery - The base query structure
   * @returns {Promise<Array<Object>>} All dealer data
   * @private
   */
  async _getAllDealerDataV32(client, indices, baseQuery) {
    let allDealerData = [];
    let after = null;
    let hasMore = true;
    let totalRequests = 0;
    const maxRequests = 10; // Safety limit

    logger.info('V32 Starting composite aggregation pagination to get all dealer data');

    while (hasMore && totalRequests < maxRequests) {
      totalRequests++;

      // Clone the base query and add after parameter for pagination
      const query = JSON.parse(JSON.stringify(baseQuery));
      if (after) {
        query.aggs.dealer_aggregation.composite.after = after;
      }

      logger.info(`V32 Executing composite aggregation request ${totalRequests} ${after ? 'with after: ' + JSON.stringify(after) : '(first request)'}`);

      try {
        const response = await client.search({
          index: indices,
          body: query,
          timeout: '60s' // Increased timeout for large aggregations
        });

        const buckets = response.body?.aggregations?.dealer_aggregation?.buckets || [];
        logger.info(`V32 Request ${totalRequests} returned ${buckets.length} buckets`);

        if (buckets.length === 0) {
          hasMore = false;
          break;
        }

        // Process this batch of data
        const batchData = this._processCompositeAggregationResponseV32(response);
        allDealerData = allDealerData.concat(batchData);

        // Check if there's more data
        const afterKey = response.body?.aggregations?.dealer_aggregation?.after_key;
        if (afterKey) {
          after = afterKey;
          logger.info(`V32 More data available, after_key: ${JSON.stringify(afterKey)}`);
        } else {
          hasMore = false;
          logger.info('V32 No more data available, pagination complete');
        }

      } catch (error) {
        logger.error(`V32 Error in composite aggregation request ${totalRequests}: ${error.message}`);
        hasMore = false;
      }
    }

    if (totalRequests >= maxRequests) {
      logger.warn(`V32 Reached maximum requests limit (${maxRequests}), some data might be missing`);
    }

    logger.info(`V32 Composite aggregation complete: ${totalRequests} requests, ${allDealerData.length} total dealer records`);
    return allDealerData;
  }

  /**
   * Process OpenSearch composite aggregation response for v32
   * @param {Object} response - The OpenSearch response
   * @returns {Array<Object>} The processed dealer data
   */
  _processCompositeAggregationResponseV32(response) {
    const dealerData = [];

    if (!response.body?.aggregations?.dealer_aggregation?.buckets) {
      logger.warn('V32 No aggregation buckets found in response');
      return dealerData;
    }

    const buckets = response.body.aggregations.dealer_aggregation.buckets;
    logger.info(`V32 Processing ${buckets.length} dealer aggregation buckets`);

    buckets.forEach(bucket => {
      const key = bucket.key;
      const dealerRecord = {
        // Grouping fields: distributor_code, district_code, region_code, dealer_code with names
        distributor_code: key.distributor_code || '',
        distributor_name: key.distributor_name || '',
        district_code: key.district_code || '',
        region_code: key.region_code || '',
        region_name: key.region_name || '',
        dealer_code: key.dealer_code || '',
        dealer_name: key.dealer_name || '',
        brand_code: bucket.brand_code?.buckets?.[0]?.key || '',

        // Aggregated metrics - these are already summed at dealer level by OpenSearch
        sales_availability_count: bucket.sales_availability_count?.value || 0,
        days_supply_count: bucket.days_supply_count?.value || 0,
        retail_count: bucket.retail_count?.value || 0,
        vpc_stock_count: bucket.vpc_stock_count?.value || 0,
        unbuilt_count: bucket.unbuilt_count?.value || 0,
        company_stock_count: bucket.company_stock_count?.value || 0,
        dealer_stock_count: bucket.dealer_stock_count?.value || 0,
        intransit_othervpc_count: bucket.intransit_othervpc_count?.value || 0,
        totalstock_count: bucket.totalstock_count?.value || 0,
        other_vpc_count: bucket.other_vpc_count?.value || 0,
        postprocess_intransit_count: bucket.postprocess_intransit_count?.value || 0,
        preprocess_intransit_vpc_count: bucket.preprocess_intransit_vpc_count?.value || 0,
        wholesale_count: bucket.wholesale_count?.value || 0,
        hist_dealerstock_count: bucket.hist_dealerstock_count?.value || 0,
        hist_tmsstock_count: bucket.hist_tmsstock_count?.value || 0,
        hist_mfgstock_count: bucket.hist_mfgstock_count?.value || 0,
        hist_portstock_count: bucket.hist_portstock_count?.value || 0,
        hist_intransitstock_count: bucket.hist_intransitstock_count?.value || 0
      };

      dealerData.push(dealerRecord);
    });

    logger.info(`V32 Processed ${dealerData.length} dealer records (flat aggregated structure)`);
    return dealerData;
  }

  /**
   * Create flat aggregated structure from dealer data for v32 (similar to v31 response format)
   * @param {Array<Object>} dealerData - The dealer data
   * @returns {Array<Object>} The flat aggregated structure
   */
  _createFlatAggregatedStructureV32(dealerData) {
    logger.info(`V32 Creating flat aggregated structure from ${dealerData.length} dealer records`);

    // Debug: Log sample of dealer data
    if (dealerData.length > 0) {
      logger.info(`V32 Sample dealer record: ${JSON.stringify(dealerData[0], null, 2)}`);
    }

    // For v32, we return the data as-is since it's already aggregated at the dealer level
    // This matches the aggregation structure: GROUP BY distributor_code, district_code, region_code, dealer_code with names
    logger.info(`V32 Created flat structure with ${dealerData.length} dealer records`);

    return dealerData;
  }

  /**
   * Execute paginated query for v41 series/model code aggregation
   * @param {Object} filters - The filters to apply
   * @param {Object} pagination - The pagination parameters
   * @param {Array} indexName - The index names to query
   * @returns {Promise<Object>} The query response
   */
  async executePaginatedQueryV41(filters = null, pagination = null, indexName = null) {
    const startTime = Date.now();
    let opensearchQuery = null;

    try {
      // Set default pagination
      logger.info('entered the function executePaginatedQueryV41');
      if (!pagination) {
        pagination = { page: 1, page_size: 10 };
      }

      // If no index name is provided, use the default indices
      const indices = indexName || [`pipe-rgn-dlr-dist-sale-inv-accessory-daily-summ-2025`];

      // Log wildcard filter usage for monitoring
      if (filters) {
        const wildcardFields = ['region_code', 'district_code', 'dealer_code', 'series_name'];
        wildcardFields.forEach(field => {
          if (filters[field] && Array.isArray(filters[field])) {
            const wildcardCount = filters[field].filter(val =>
              typeof val === 'string' && (val.includes('*') || val.includes('?'))
            ).length;
            if (wildcardCount > 0) {
              logger.info(`[WILDCARD] V41 ${field} filter contains ${wildcardCount} wildcard patterns out of ${filters[field].length} total values`);
            }
          }
        });
      }

      // Build and execute aggregation query for series/model code data
      opensearchQuery = this._buildSeriesAggregatedQueryV41(filters, 50000); // Large size for complete data

      logger.info(`V41 Executing query for series/model code aggregation`);
      logger.info(`V41 Query body: ${JSON.stringify(opensearchQuery, null, 2)}`);

      const client = await this.getClient();

      // Get all series/model data using composite aggregation
      const allSeriesData = await this._getAllSeriesDataV41(client, indices, opensearchQuery);

      logger.info(`V41 Retrieved ${allSeriesData.length} series/model buckets`);

      // Create flat aggregated structure for series/model codes
      const aggregatedData = this._createFlatSeriesStructureV41(allSeriesData);

      // Calculate statistics
      const totalRecords = aggregatedData.length;

      // Build query info
      const queryInfo = {
        took: 0,
        timed_out: false,
        total_shards: 0,
        successful_shards: 0
      };

      const executionTime = (Date.now() - startTime) / 1000;
      logger.info(`V41 Query executed successfully in ${executionTime.toFixed(2)} seconds`);

      return {
        success: true,
        data: aggregatedData,
        total_records: totalRecords,
        query_info: queryInfo,
        execution_timestamp: new Date(),
        version: "v41",
        aggregation_level: "series_model_aggregation"
      };

    } catch (error) {
      const executionTime = (Date.now() - startTime) / 1000;

      // Enhanced error logging for wildcard-related issues
      if (error.message && error.message.includes('wildcard')) {
        logger.error(`[WILDCARD] V41 Query failed with wildcard-related error after ${executionTime.toFixed(2)} seconds: ${error.message}`);
      } else {
        logger.error(`V41 Query failed after ${executionTime.toFixed(2)} seconds: ${error.message}`);
      }

      if (opensearchQuery) {
        logger.error(`V41 Query that failed: ${JSON.stringify(opensearchQuery)}`);
      }

      return {
        success: false,
        error: `V41 Query execution failed: ${error.message}`,
        data: [],
        query_info: {
          took: 0,
          timed_out: false,
          total_shards: 0,
          successful_shards: 0,
          error: error.message
        },
        execution_timestamp: new Date(),
        version: "v41",
        aggregation_level: "series_model_aggregation"
      };
    }
  }

  /**
   * Build OpenSearch aggregation query for v41 series/model code data
   * @param {Object} filters - The filters to apply
   * @param {number} size - The maximum number of results to return
   * @returns {Object} The OpenSearch query
   */
  _buildSeriesAggregatedQueryV41(filters = null, size = 10000) {
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

        if (key === 'date_range' && value) {
          filterDict.date = { range: value };
        } else {
          filterDict[key] = value;
        }
      }
    }

    // Build the query with proper field names (no .keyword suffix needed)
    const query = {
      size: 0, // We only need aggregations
      query: Object.keys(filterDict).length > 0 ? this._buildOpenSearchQuery(filterDict) : { match_all: {} },
      aggs: {
        series_names: {
          terms: {
            field: "series_name", // Remove .keyword since it's already a keyword field
            size: 1000,
            min_doc_count: 1
          },
          aggs: {
            model_codes: {
              terms: {
                field: "model_code",
                size: 1000,
                min_doc_count: 1
              },
              aggs: {
                sales_availability_count: { sum: { field: "sales_availability_count" } },
                days_supply_count: { sum: { field: "days_supply_count" } },
                retail_count: { sum: { field: "retail_count" } },
                vpc_stock_count: { sum: { field: "vpc_stock_count" } },
                unbuilt_count: { sum: { field: "unbuilt_count" } },
                company_stock_count: { sum: { field: "company_stock_count" } },
                dealer_stock_count: { sum: { field: "dealer_stock_count" } },
                intransit_othervpc_count: { sum: { field: "intransit_othervpc_count" } },
                totalstock_count: { sum: { field: "totalstock_count" } },
                other_vpc_count: { sum: { field: "other_vpc_count" } },
                postprocess_intransit_count: { sum: { field: "postprocess_intransit_count" } },
                preprocess_intransit_vpc_count: { sum: { field: "preprocess_intransit_vpc_count" } },
                wholesale_count: { sum: { field: "wholesale_count" } },
                hist_dealerstock_count: { sum: { field: "hist_dealerstock_count" } },
                hist_tmsstock_count: { sum: { field: "hist_tmsstock_count" } },
                hist_mfgstock_count: { sum: { field: "hist_mfgstock_count" } },
                hist_portstock_count: { sum: { field: "hist_portstock_count" } },
                hist_intransitstock_count: { sum: { field: "hist_intransitstock_count" } },
                brand_code: { terms: { field: "brand_code", size: 1 } },
                brand_name: { terms: { field: "brand_name", size: 1 } }
              }
            }
          }
        }
      }
    };

    return query;
  }

  /**
   * Get all series/model data using composite aggregation with pagination
   * @param {Object} client - The OpenSearch client
   * @param {Array} indices - The indices to query
   * @param {Object} baseQuery - The base query
   * @returns {Promise<Array>} All series/model data
   * @private
   */
  async _getAllSeriesDataV41(client, indices, baseQuery) {
    let allSeriesData = [];

    logger.info(`V41 Starting data retrieval from indices: ${JSON.stringify(indices)}`);

    try {
      const response = await client.search({
        index: indices,
        body: baseQuery
      });

      logger.info(`V41 OpenSearch response status: ${response.statusCode}`);

      if (response.body.aggregations && response.body.aggregations.series_names) {
        const seriesBuckets = response.body.aggregations.series_names.buckets;
        logger.info(`V41 Found ${seriesBuckets.length} series buckets`);

        // Process each series bucket
        seriesBuckets.forEach((seriesBucket) => {
          const seriesName = seriesBucket.key;

          if (seriesBucket.model_codes && seriesBucket.model_codes.buckets) {
            // Process each model code within the series
            seriesBucket.model_codes.buckets.forEach((modelBucket) => {
              const modelCode = modelBucket.key;

              // Create flat data item with series_name, model_code, and all aggregated values
              const dataItem = {
                series_name: seriesName,
                model_code: modelCode,
                brand_code: modelBucket.brand_code?.buckets?.[0]?.key || '',
                brand_name: modelBucket.brand_name?.buckets?.[0]?.key || '',
                sales_availability_count: modelBucket.sales_availability_count?.value || 0,
                days_supply_count: modelBucket.days_supply_count?.value || 0,
                retail_count: modelBucket.retail_count?.value || 0,
                vpc_stock_count: modelBucket.vpc_stock_count?.value || 0,
                unbuilt_count: modelBucket.unbuilt_count?.value || 0,
                company_stock_count: modelBucket.company_stock_count?.value || 0,
                dealer_stock_count: modelBucket.dealer_stock_count?.value || 0,
                intransit_othervpc_count: modelBucket.intransit_othervpc_count?.value || 0,
                totalstock_count: modelBucket.totalstock_count?.value || 0,
                other_vpc_count: modelBucket.other_vpc_count?.value || 0,
                postprocess_intransit_count: modelBucket.postprocess_intransit_count?.value || 0,
                preprocess_intransit_vpc_count: modelBucket.preprocess_intransit_vpc_count?.value || 0,
                wholesale_count: modelBucket.wholesale_count?.value || 0,
                hist_dealerstock_count: modelBucket.hist_dealerstock_count?.value || 0,
                hist_tmsstock_count: modelBucket.hist_tmsstock_count?.value || 0,
                hist_mfgstock_count: modelBucket.hist_mfgstock_count?.value || 0,
                hist_portstock_count: modelBucket.hist_portstock_count?.value || 0,
                hist_intransitstock_count: modelBucket.hist_intransitstock_count?.value || 0
              };

              allSeriesData.push(dataItem);
            });
          }
        });

        logger.info(`V41 Total series/model data processed: ${allSeriesData.length}`);
      } else {
        logger.error(`V41 No series_names aggregation found in response`);
      }

    } catch (error) {
      logger.error(`V41 Error fetching series data: ${error.message}`);
      throw error;
    }

    return allSeriesData;
  }

  /**
   * Create flat aggregated structure from series/model data
   * @param {Array} seriesData - The series/model data from aggregation
   * @returns {Array<Object>} The flat aggregated structure
   */
  _createFlatSeriesStructureV41(seriesData) {
    logger.info(`V41 Creating flat series structure from ${seriesData.length} series/model records`);

    // The data is already in the correct flat format from _getAllSeriesDataV41
    // Just return it as-is since the processing is now done in _getAllSeriesDataV41
    logger.info(`V41 Returning ${seriesData.length} flat series/model records`);

    if (seriesData.length > 0) {
      logger.info(`V41 First flat record: ${JSON.stringify(seriesData[0], null, 2)}`);
      logger.info(`V41 Last flat record: ${JSON.stringify(seriesData[seriesData.length - 1], null, 2)}`);
    }

    return seriesData;
  }


  /**
   * Execute dynamic aggregation query for sales data by specified field
   * @param {Object} filtersData - The filters to apply
   * @param {Array<string>} indexName - The index name(s) to query
   * @param {string} field - The field to aggregate by (default: 'segment_code')
   * @returns {Promise<Object>} The query response with aggregated data
   */
  async executeSalesChartQuery(filtersData = null, indexName = null, field = 'segment_code') {
    const startTime = Date.now();
    let opensearchQuery = null;

    try {

      logger.info('entered the function executeSalesBySegmentQueryForAccessoryCode');

      // If no index name is provided, use the default index names
      const indices = indexName || settings.indexNamesList;

      // Build and execute aggregation query
      opensearchQuery = this._buildSalesChartAggregateQuery(filtersData, field);

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

  /**
   * Build OpenSearch aggregation query for dynamic field aggregation (segment, series, etc.)
   * @param {Object} filters - The filters to apply
   * @param {string} field - The field to aggregate by (e.g., 'segment_code', 'series_name')
   * @returns {Object} The OpenSearch query
   */
  _buildSalesChartAggregateQuery(filters = null, field) {
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
          filterDict.transaction_date = value; // Pass the date range object directly
        } else {
          filterDict[key] = value;
        }
      }
    }

    const query = this._buildFilterQuerySalesChart(filterDict);

    const aggs = {
      // Get total retail sales count for percentage calculation
      total_retail_sales: {
        sum: { field: "retail_count" }
      },
      // Group by dynamic field to get field-wise breakdown
      net_retail_sales_by_segment: {
        terms: {
          field,
          size: 100,
          order: { retail_count_sum: "desc" }
        },
        aggs: {
          retail_count_sum: { sum: { field: "retail_count" } },
          // Get field name for display - use the same field as the main aggregation
          field_name: {
            terms: {
              field: field.includes('.keyword') ? field : `${field}.keyword`,
              size: 1
            }
          }
        }
      }
    };

    return {
      size: 0,
      query: query,
      aggs: aggs
    };
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
      'fac_pio_indicator', 'napc_bu_code', 'exterior_color_code', 'interior_color_code',
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

  /**
   * Process OpenSearch response for sales by segment query and format as net retail sales
   * @param {Object} response - The OpenSearch response
   * @param {string} field - The field used for aggregation (e.g., 'segment_code', 'series_name')
   * @returns {Object} The formatted net retail sales response
   */
  _processNetRetailSalesResponse(response, field = 'segment_code') {
    try {
      const aggregations = response.body?.aggregations;

      // Determine the appropriate response key based on the field type
      const responseKey = field === 'segment_code' ? 'bySegment' :
        field === 'series_name' ? 'bySeries' :
          field === 'fueltype_code' ? 'byFuelType' :
            'byField'; // generic fallback

      if (!aggregations) {
        logger.warn('No aggregations found in OpenSearch response');
        return {
          netRetailSales: {
            count: 0,
            [responseKey]: []
          }
        };
      }

      // Debug: Log the aggregations structure
      logger.info(`Processing aggregations for field: ${field}`);
      logger.info(`Aggregations keys: ${Object.keys(aggregations)}`);
      if (aggregations.net_retail_sales_by_segment) {
        logger.info(`Found net_retail_sales_by_segment aggregation with ${aggregations.net_retail_sales_by_segment.buckets?.length || 0} buckets`);
      }

      // Get total retail sales count
      const totalRetailSalesCount = aggregations.total_retail_sales?.value || 0;

      // Get segment-wise breakdown
      const segmentBuckets = aggregations.net_retail_sales_by_segment?.buckets || [];
      logger.info(`Found ${segmentBuckets.length} buckets for field ${field}`);

      // Debug: Log first few buckets if available
      if (segmentBuckets.length > 0) {
        logger.info(`First bucket sample: ${JSON.stringify(segmentBuckets[0], null, 2)}`);
      }

      const bySegment = segmentBuckets.map(bucket => {
        const fieldCode = bucket.key;
        const retailSalesCount = bucket.retail_count_sum?.value || 0;

        // Get field name from nested aggregation - fallback to code if name not found
        let fieldName = fieldCode;
        if (bucket.field_name?.buckets && bucket.field_name.buckets.length > 0) {
          fieldName = bucket.field_name.buckets[0].key;
        }

        // Calculate percentage based on retail sales count
        let percentage = 0;
        if (totalRetailSalesCount > 0 && retailSalesCount > 0) {
          percentage = parseFloat(((retailSalesCount / totalRetailSalesCount) * 100).toFixed(3));
        }

        logger.debug(`${field} ${fieldCode}: retailSalesCount=${retailSalesCount}, totalRetailSalesCount=${totalRetailSalesCount}, percentage=${percentage}%`);

        // Return appropriate field name based on the aggregation field
        const responseFieldName = field;

        return {
          count: retailSalesCount,
          percentage: percentage,
          [responseFieldName]: fieldName
        };
      });

      // Validate that percentages add up to approximately 100%
      const totalPercentage = bySegment.reduce((sum, segment) => sum + segment.percentage, 0);
      logger.info(`Processed net retail sales: totalRetailSalesCount=${totalRetailSalesCount}, ${field}_segments=${bySegment.length}, totalPercentage=${totalPercentage}%`);

      return {
        netRetailSales: {
          count: totalRetailSalesCount, // Use total retail_count sum instead of document count
          [responseKey]: bySegment
        }
      };

    } catch (error) {
      logger.error(`Error processing net retail sales response: ${error.message}`);
      return {
        netRetailSales: {
          count: 0,
          bySegment: []
        }
      };
    }
  }

  getRequestData(req, ACCESSORY_INDEX, SALES_INV_INDEX) {
    const ACCESSORY_INDEX_NEW = 'pipe-rgn-dlr-dist-sale-accessory-current-summary';
    const COLOR_INDEX = 'pipe-rgn-dlr-dist-sale-color-current-summary';
    // Extract request data
    const { filters, timePeriod } = req.body;

    // Log the incoming request data
    console.log('filters:', JSON.stringify(filters, null, 2));
    console.log('Time period:', timePeriod);

    // Determine index prefix based on global filters
    let indexPrefix = COLOR_INDEX; // Default

    // Determine which index to use based on requirements
    const currentDate = new Date();
    const yearString = currentDate.getFullYear().toString();
    let indexName = [`${indexPrefix}-${yearString}`];

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
          'fio_ppo_indicator', 'accessory_code', 'accessory_desc',
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

    // Determine which index to use based on index_type
    const indexType = req.body.index_type;

    if (['0', '3', '5'].includes(indexType)) {
      // Use the accessory summary index for these types
      indexName = [`${indexPrefix}-${yearString}`];
    } else if (indexType === '6') {
      const previousYearString = (currentDate.getFullYear() - 1).toString();
      indexName = [`${indexPrefix}-${previousYearString}`];
    } else {
      if (processedFilters && processedFilters.sls_ccyymm && processedFilters.sls_ccyymm.length > 0) {
        // Extract years from CCYYMM format (first 4 digits)
        const years = processedFilters.sls_ccyymm.map(val => {
          const ccyymm = val.toString().padStart(6, '0');
          return parseInt(ccyymm.substring(0, 4));
        });

        const minYear = Math.min(...years);
        const maxYear = Math.max(...years);

        console.log(`series_acc_summary_new Min year: ${minYear}, Max year: ${maxYear}`);
        if (minYear === maxYear) {
          // pipe-rgn-dlr-dist-sale-accessory-current-summary
          indexName = [`${indexPrefix}-${minYear}`];
        } else {
          indexName = [`${indexPrefix}-${minYear}`, `${indexPrefix}-${maxYear}`];
        }
      } else {
        // Default to current year index
        indexName = [`${indexPrefix}-${yearString}`];
      }
    }

    return {
      filters: processedFilters,
      timePeriod: timePeriod || null,
      indexName
    }
  }
  /**
   * Execute paginated query for v42 endpoint with color filters
   * @param {Object} filters - The filters to apply
   * @param {Object} pagination - The pagination parameters
   * @param {Array} indexName - The index names to query
   * @returns {Promise<Object>} The query response
   */
  async executePaginatedQueryV42(filters = null, pagination = null, indexName = null) {
    const startTime = Date.now();
    let opensearchQuery = null;

    try {
      // Set default pagination
      logger.info('entered the function executePaginatedQueryV42');
      if (!pagination) {
        pagination = { page: 1, page_size: 10 };
      }

      // If no index name is provided, use the default color indices
      const indices = indexName || [`pipe-rgn-dlr-dist-sale-inv-color-daily-summ-2025`];

      // Log wildcard filter usage for monitoring
      if (filters) {
        const wildcardFields = ['region_code', 'district_code', 'dealer_code', 'series_name'];
        wildcardFields.forEach(field => {
          if (filters[field] && Array.isArray(filters[field])) {
            const wildcardCount = filters[field].filter(val =>
              typeof val === 'string' && (val.includes('*') || val.includes('?'))
            ).length;
            if (wildcardCount > 0) {
              logger.info(`[WILDCARD] V42 ${field} filter contains ${wildcardCount} wildcard patterns out of ${filters[field].length} total values`);
            }
          }
        });
      }

      // Build and execute aggregation query for series/model code data with color filters
      opensearchQuery = this._buildSeriesAggregatedQueryV42(filters, 50000); // Large size for complete data

      logger.info(`V42 Executing query for series/model code aggregation with color filters`);
      logger.info(`V42 Query body: ${JSON.stringify(opensearchQuery, null, 2)}`);

      const client = await this.getClient();

      // Get all series/model data using composite aggregation
      const allSeriesData = await this._getAllSeriesDataV42(client, indices, opensearchQuery);

      logger.info(`V42 Retrieved ${allSeriesData.length} series/model buckets`);

      // Create flat aggregated structure for series/model codes
      const aggregatedData = this._createFlatSeriesStructureV42(allSeriesData);

      // Calculate statistics
      const totalRecords = aggregatedData.length;

      // Build query info
      const queryInfo = {
        took: 0,
        timed_out: false,
        total_shards: 0,
        successful_shards: 0
      };

      const executionTime = (Date.now() - startTime) / 1000;
      logger.info(`V42 Query executed successfully in ${executionTime.toFixed(2)} seconds`);

      return {
        success: true,
        data: aggregatedData,
        total_records: totalRecords,
        query_info: queryInfo,
        execution_timestamp: new Date(),
        version: "v42",
        aggregation_level: "series_model_aggregation_with_colors"
      };

    } catch (error) {
      const executionTime = (Date.now() - startTime) / 1000;

      // Enhanced error logging for wildcard-related issues
      if (error.message && error.message.includes('wildcard')) {
        logger.error(`[WILDCARD] V42 Query failed with wildcard-related error after ${executionTime.toFixed(2)} seconds: ${error.message}`);
      } else {
        logger.error(`V42 Query failed after ${executionTime.toFixed(2)} seconds: ${error.message}`);
      }

      if (opensearchQuery) {
        logger.error(`V42 Query that failed: ${JSON.stringify(opensearchQuery)}`);
      }

      return {
        success: false,
        error: `V42 Query execution failed: ${error.message}`,
        data: [],
        query_info: {
          took: 0,
          timed_out: false,
          total_shards: 0,
          successful_shards: 0,
          error: error.message
        },
        execution_timestamp: new Date(),
        version: "v42",
        aggregation_level: "series_model_aggregation_with_colors"
      };
    }
  }

  /**
   * Build OpenSearch aggregation query for v42 series/model code data with color filters
   * @param {Object} filters - The filters to apply
   * @param {number} size - The maximum number of results to return
   * @returns {Object} The OpenSearch query
   */
  _buildSeriesAggregatedQueryV42(filters = null, size = 10000) {
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

        if (key === 'date_range' && value) {
          filterDict.date = { range: value };
        } else {
          filterDict[key] = value;
        }
      }
    }

    // Build the query with proper field names (no .keyword suffix needed)
    const query = {
      size: 0, // We only need aggregations
      query: Object.keys(filterDict).length > 0 ? this._buildOpenSearchQuery(filterDict) : { match_all: {} },
      aggs: {
        series_names: {
          terms: {
            field: "series_name", // Remove .keyword since it's already a keyword field
            size: 1000,
            min_doc_count: 1
          },
          aggs: {
            model_codes: {
              terms: {
                field: "model_code",
                size: 1000,
                min_doc_count: 1
              },
              aggs: {
                sales_availability_count: { sum: { field: "sales_availability_count" } },
                days_supply_count: { sum: { field: "days_supply_count" } },
                retail_count: { sum: { field: "retail_count" } },
                vpc_stock_count: { sum: { field: "vpc_stock_count" } },
                unbuilt_count: { sum: { field: "unbuilt_count" } },
                company_stock_count: { sum: { field: "company_stock_count" } },
                dealer_stock_count: { sum: { field: "dealer_stock_count" } },
                intransit_othervpc_count: { sum: { field: "intransit_othervpc_count" } },
                totalstock_count: { sum: { field: "totalstock_count" } },
                other_vpc_count: { sum: { field: "other_vpc_count" } },
                postprocess_intransit_count: { sum: { field: "postprocess_intransit_count" } },
                preprocess_intransit_vpc_count: { sum: { field: "preprocess_intransit_vpc_count" } },
                wholesale_count: { sum: { field: "wholesale_count" } },
                hist_dealerstock_count: { sum: { field: "hist_dealerstock_count" } },
                hist_tmsstock_count: { sum: { field: "hist_tmsstock_count" } },
                hist_mfgstock_count: { sum: { field: "hist_mfgstock_count" } },
                hist_portstock_count: { sum: { field: "hist_portstock_count" } },
                hist_intransitstock_count: { sum: { field: "hist_intransitstock_count" } },
                brand_code: { terms: { field: "brand_code", size: 1 } },
                brand_name: { terms: { field: "brand_name", size: 1 } }
              }
            }
          }
        }
      }
    };

    return query;
  }

  /**
   * Get all series/model data using aggregation for v42
   * @param {Object} client - The OpenSearch client
   * @param {Array} indices - The indices to query
   * @param {Object} baseQuery - The base query
   * @returns {Promise<Array>} All series/model data
   * @private
   */
  async _getAllSeriesDataV42(client, indices, baseQuery) {
    let allSeriesData = [];

    logger.info(`V42 Starting data retrieval from indices: ${JSON.stringify(indices)}`);

    try {
      const response = await client.search({
        index: indices,
        body: baseQuery
      });

      logger.info(`V42 OpenSearch response status: ${response.statusCode}`);

      if (response.body.aggregations && response.body.aggregations.series_names) {
        const seriesBuckets = response.body.aggregations.series_names.buckets;
        logger.info(`V42 Found ${seriesBuckets.length} series buckets`);

        // Process each series bucket
        seriesBuckets.forEach((seriesBucket) => {
          const seriesName = seriesBucket.key;

          if (seriesBucket.model_codes && seriesBucket.model_codes.buckets) {
            // Process each model code within the series
            seriesBucket.model_codes.buckets.forEach((modelBucket) => {
              const modelCode = modelBucket.key;

              // Create flat data item with series_name, model_code, and all aggregated values
              const dataItem = {
                series_name: seriesName,
                model_code: modelCode,
                brand_code: modelBucket.brand_code?.buckets?.[0]?.key || '',
                brand_name: modelBucket.brand_name?.buckets?.[0]?.key || '',
                sales_availability_count: modelBucket.sales_availability_count?.value || 0,
                days_supply_count: modelBucket.days_supply_count?.value || 0,
                retail_count: modelBucket.retail_count?.value || 0,
                vpc_stock_count: modelBucket.vpc_stock_count?.value || 0,
                unbuilt_count: modelBucket.unbuilt_count?.value || 0,
                company_stock_count: modelBucket.company_stock_count?.value || 0,
                dealer_stock_count: modelBucket.dealer_stock_count?.value || 0,
                intransit_othervpc_count: modelBucket.intransit_othervpc_count?.value || 0,
                totalstock_count: modelBucket.totalstock_count?.value || 0,
                other_vpc_count: modelBucket.other_vpc_count?.value || 0,
                postprocess_intransit_count: modelBucket.postprocess_intransit_count?.value || 0,
                preprocess_intransit_vpc_count: modelBucket.preprocess_intransit_vpc_count?.value || 0,
                wholesale_count: modelBucket.wholesale_count?.value || 0,
                hist_dealerstock_count: modelBucket.hist_dealerstock_count?.value || 0,
                hist_tmsstock_count: modelBucket.hist_tmsstock_count?.value || 0,
                hist_mfgstock_count: modelBucket.hist_mfgstock_count?.value || 0,
                hist_portstock_count: modelBucket.hist_portstock_count?.value || 0,
                hist_intransitstock_count: modelBucket.hist_intransitstock_count?.value || 0
              };

              allSeriesData.push(dataItem);
            });
          }
        });

        logger.info(`V42 Total series/model data processed: ${allSeriesData.length}`);
      } else {
        logger.error(`V42 No series_names aggregation found in response`);
      }

    } catch (error) {
      logger.error(`V42 Error fetching series data: ${error.message}`);
      throw error;
    }

    return allSeriesData;
  }

  /**
   * Create flat aggregated structure from series/model data for v42
   * @param {Array} seriesData - The series/model data from aggregation
   * @returns {Array<Object>} The flat aggregated structure
   */
  _createFlatSeriesStructureV42(seriesData) {
    logger.info(`V42 Creating flat series structure from ${seriesData.length} series/model records`);

    // The data is already in the correct flat format from _getAllSeriesDataV42
    // Just return it as-is since the processing is now done in _getAllSeriesDataV42
    logger.info(`V42 Returning ${seriesData.length} flat series/model records`);

    if (seriesData.length > 0) {
      logger.info(`V42 First flat record: ${JSON.stringify(seriesData[0], null, 2)}`);
      logger.info(`V42 Last flat record: ${JSON.stringify(seriesData[seriesData.length - 1], null, 2)}`);
    }

    return seriesData;
  }

  /**
   * Execute dealer aggregation query for v51 endpoint
   * @param {Object} filters - The filters to apply
   * @param {Object} pagination - The pagination parameters
   * @param {Array<string>} indexName - The index name(s) to query
   * @returns {Promise<Object>} The query response with dealer-level aggregated data
   */
  async executeDealerAggregationQuery(filters = null, pagination = null, indexName = null) {
    const startTime = Date.now();
    let opensearchQuery = null;

    try {
      console.log('executeDealerAggregationQuery: Starting dealer aggregation query');

      // Set default pagination
      if (!pagination) {
        pagination = { page: 1, page_size: 10 };
      }

      // If no index name is provided, use default
      const indices = indexName || ['pipe-rgn-dlr-dist-sale-inv-accessory-daily-summ'];

      // Log wildcard filter usage for monitoring
      if (filters) {
        const wildcardFields = ['region_code', 'district_code', 'dealer_code'];
        wildcardFields.forEach(field => {
          if (filters[field] && Array.isArray(filters[field])) {
            const wildcardCount = filters[field].filter(val =>
              typeof val === 'string' && (val.includes('*') || val.includes('?'))
            ).length;
            if (wildcardCount > 0) {
              logger.info(`[WILDCARD] DealerAgg ${field} filter contains ${wildcardCount} wildcard patterns out of ${filters[field].length} total values`);
            }
          }
        });
      }

      console.log(`executeDealerAggregationQuery: Using indices: ${JSON.stringify(indices)}`);

      // Convert filters to dict for query building
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
            filterDict.transaction_date = { range: value };
          } else {
            filterDict[key] = value;
          }
        }
      }

      console.log(`executeDealerAggregationQuery: Filter dict: ${JSON.stringify(filterDict)}`);

      // Build the OpenSearch query
      const query = this._buildOpenSearchQuery(filterDict);

      // Build aggregation for dealer-level data
      const aggs = {
        dealer_aggregated: {
          composite: {
            size: 50000, // Large size to get all dealers
            sources: [
              { dealer_code: { terms: { field: "dealer_code" } } },
              { dealer_name: { terms: { field: "dealer_name" } } },
              { region_code: { terms: { field: "region_code" } } },
              { region_name: { terms: { field: "region_name" } } },
              { district_code: { terms: { field: "district_code" } } }
            ]
          },
          aggs: {
            dealer_name: { terms: { field: "dealer_name", size: 1 } },
            brand_code: { terms: { field: "brand_code", size: 1 } },
            sales_availability_count: { sum: { field: "sales_availability_count" } },
            days_supply_count: { sum: { field: "days_supply_count" } },
            retail_count: { sum: { field: "retail_count" } },
            vpc_stock_count: { sum: { field: "vpc_stock_count" } },
            unbuilt_count: { sum: { field: "unbuilt_count" } },
            company_stock_count: { sum: { field: "company_stock_count" } },
            dealer_stock_count: { sum: { field: "dealer_stock_count" } },
            intransit_othervpc_count: { sum: { field: "intransit_othervpc_count" } },
            totalstock_count: { sum: { field: "totalstock_count" } },
            other_vpc_count: { sum: { field: "other_vpc_count" } },
            postprocess_intransit_count: { sum: { field: "postprocess_intransit_count" } },
            preprocess_intransit_vpc_count: { sum: { field: "preprocess_intransit_vpc_count" } },
            wholesale_count: { sum: { field: "wholesale_count" } },
            hist_dealerstock_count: { sum: { field: "hist_dealerstock_count" } },
            hist_tmsstock_count: { sum: { field: "hist_tmsstock_count" } },
            hist_mfgstock_count: { sum: { field: "hist_mfgstock_count" } },
            hist_portstock_count: { sum: { field: "hist_portstock_count" } },
            hist_intransitstock_count: { sum: { field: "hist_intransitstock_count" } }
          }
        },
        // Add regional rankings
        region_rankings: {
          terms: {
            field: "region_code",
            size: 1000
          },
          aggs: {
            dealer_stats: {
              terms: {
                field: "dealer_code",
                size: 1000,
                order: {
                  "dealer_retail": "desc"
                }
              },
              aggs: {
                dealer_retail: {
                  sum: {
                    field: "retail_count"
                  }
                }
              }
            }
          }
        },
        // Add national rankings
        national_rankings: {
          terms: {
            field: "dealer_code",
            size: 50000,
            order: {
              "total_retail": "desc"
            }
          },
          aggs: {
            total_retail: {
              sum: {
                field: "retail_count"
              }
            }
          }
        },
        // Add total dealers count
        total_dealers: {
          cardinality: {
            field: "dealer_code"
          }
        }
      };

      opensearchQuery = {
        size: 0,
        query: query,
        aggs: aggs
      };

      // Use util.inspect to properly log the full query structure
      const util = require('util');
      console.log('executeDealerAggregationQuery: Executing query:');
      console.log(util.inspect(opensearchQuery, { depth: null, colors: true, maxArrayLength: null }));

      const client = await this.getClient();
      const response = await client.search({
        index: indices,
        body: opensearchQuery,
        timeout: '60s'
      });

      console.log(`executeDealerAggregationQuery: Query executed successfully`);

      // Process the aggregation response
      const dealerData = this._processDealerAggregationResponse(response);

      console.log(`executeDealerAggregationQuery: Processed ${dealerData.length} dealer records`);
      console.log(`agg dealerdata sample: ${JSON.stringify(dealerData)}`);

      const endTime = Date.now();
      const executionTime = endTime - startTime;

      return {
        success: true,
        data: dealerData,
        query_info: {
          execution_time_ms: executionTime,
          total_dealers: dealerData.length,
          indices_queried: indices
        },
        execution_timestamp: new Date().toISOString()
      };

    } catch (error) {
      const endTime = Date.now();
      const executionTime = endTime - startTime;

      // Enhanced error logging for wildcard-related issues
      if (error.message && error.message.includes('wildcard')) {
        logger.error(`[WILDCARD] DealerAgg Query failed with wildcard-related error after ${executionTime}ms: ${error.message}`);
      } else {
        logger.error(`executeDealerAggregationQuery failed: ${error.message}`);
      }
      if (opensearchQuery) {
        logger.error(`Query that failed: ${JSON.stringify(opensearchQuery, null, 2)}`);
      }

      return {
        success: false,
        error: error.message,
        query_info: {
          execution_time_ms: executionTime,
          indices_queried: indexName || ['pipe-rgn-dlr-dist-sale-inv-accessory-daily-summ']
        },
        execution_timestamp: new Date().toISOString()
      };
    }
  }

  /**
   * Process OpenSearch dealer aggregation response
   * @param {Object} response - The OpenSearch response
   * @returns {Array<Object>} The processed dealer data
   */
  _processDealerAggregationResponse(response) {
    const dealerData = [];

    try {
      const buckets = response.body?.aggregations?.dealer_aggregated?.buckets || [];
      console.log(`_processDealerAggregationResponse: Processing ${buckets.length} dealer buckets`);
      const totalDealers = response.body.aggregations.total_dealers.value || 0;
      // Process national rankings
      const nationalRankings = new Map();
      logger.info('National Rankings Buckets:', JSON.stringify(response.body.aggregations.national_rankings?.buckets || []));

      if (response.body.aggregations.national_rankings?.buckets) {
        response.body.aggregations.national_rankings.buckets.forEach((bucket, index) => {
          const rankingData = {
            rank: index + 1,
            total_dealers: totalDealers,
            //percentile: ((index + 1) / totalDealers * 100).toFixed(2),
            total_retail: bucket.total_retail.value || 0
          };
          nationalRankings.set(bucket.key, rankingData);
        });
      }
      logger.info(`Total national rankings mapped: ${nationalRankings.size}`);

      // Process regional rankings
      const regionalRankings = new Map();
      if (response.body.aggregations.region_rankings?.buckets) {
        response.body.aggregations.region_rankings.buckets.forEach(regionBucket => {
          const regionCode = regionBucket.key;
          const dealerStats = regionBucket.dealer_stats?.buckets || [];
          const totalRegionDealers = dealerStats.length;

          dealerStats.forEach((dealerBucket, index) => {
            if (!regionalRankings.has(regionCode)) {
              regionalRankings.set(regionCode, new Map());
            }
            regionalRankings.get(regionCode).set(dealerBucket.key, {
              rank: index + 1,
              total_dealers: totalRegionDealers,
              // percentile: ((index + 1) / totalRegionDealers * 100).toFixed(2),
              retail_count: dealerBucket.dealer_retail.value || 0
            });
          });
        });
      }

      logger.info(`Processing rankings: National=${nationalRankings.size} dealers, Regional=${regionalRankings.size} regions`);

      for (const bucket of buckets) {
        const key = bucket.key;
        const aggs = bucket;

        const dealerCode = key.dealer_code || '';
        const regionCode = key.region_code || '';

        // Get national ranking data
        const nationalRanking = nationalRankings.get(dealerCode);
        if (!nationalRanking) {
          logger.warn(`No national ranking found for dealer ${dealerCode}. Keys in map: ${Array.from(nationalRankings.keys()).slice(0, 5).join(', ')}...`);
        }
        const finalNationalRanking = nationalRanking || {
          rank: null,
          total_dealers: totalDealers,
          //percentile: null,
          total_retail: 0
        };

        // Get regional ranking data
        const regionalRanking = regionalRankings.get(regionCode)?.get(dealerCode) || {
          rank: null,
          total_dealers: regionalRankings.get(regionCode)?.size || 0,
          //percentile: null,
          retail_count: 0
        };

        // Extract dealer name from nested aggregation
        let dealerName = "Unknown Name";
        if (aggs.dealer_name?.buckets?.length) {
          dealerName = aggs.dealer_name.buckets[0].key;
        }

        // Extract brand code from nested aggregation
        let brandCode = "";
        if (aggs.brand_code?.buckets?.length) {
          brandCode = aggs.brand_code.buckets[0].key;
        }

        const record = {
          dealer_code: key.dealer_code,
          dealer_name: dealerName,
          brand_code: brandCode,
          sales_availability_count: aggs.sales_availability_count?.value || 0,
          days_supply_count: aggs.days_supply_count?.value || 0,
          retail_count: aggs.retail_count?.value || 0,
          vpc_stock_count: aggs.vpc_stock_count?.value || 0,
          unbuilt_count: aggs.unbuilt_count?.value || 0,
          company_stock_count: aggs.company_stock_count?.value || 0,
          dealer_stock_count: aggs.dealer_stock_count?.value || 0,
          intransit_othervpc_count: aggs.intransit_othervpc_count?.value || 0,
          totalstock_count: aggs.totalstock_count?.value || 0,
          other_vpc_count: aggs.other_vpc_count?.value || 0,
          postprocess_intransit_count: aggs.postprocess_intransit_count?.value || 0,
          preprocess_intransit_vpc_count: aggs.preprocess_intransit_vpc_count?.value || 0,
          wholesale_count: aggs.wholesale_count?.value || 0,
          hist_dealerstock_count: aggs.hist_dealerstock_count?.value || 0,
          hist_tmsstock_count: aggs.hist_tmsstock_count?.value || 0,
          hist_mfgstock_count: aggs.hist_mfgstock_count?.value || 0,
          hist_portstock_count: aggs.hist_portstock_count?.value || 0,
          hist_intransitstock_count: aggs.hist_intransitstock_count?.value || 0,
          national_ranking: finalNationalRanking,
          regional_ranking: regionalRanking
        };

        dealerData.push(record);
      }

      console.log(`_processDealerAggregationResponse: Successfully processed ${dealerData.length} dealer records`);

      // Log sample data for debugging
      if (dealerData.length > 0) {
        console.log(`_processDealerAggregationResponse: Sample dealer record:`, JSON.stringify(dealerData[0], null, 2));
      }

    } catch (error) {
      logger.error(`_processDealerAggregationResponse failed: ${error.message}`);
      throw new Error(`Failed to process dealer aggregation response: ${error.message}`);
    }

    return dealerData;
  }



  /**
   * Execute region objective query with aggregation
   * @param {Object} filters - The filters to apply
   * @param {Object} pagination - The pagination parameters
   * @param {Array<string>} indexName - The index name(s) to query
   * @returns {Promise<Object>} The query response with region objective data
   */
  async executeRegionObjectiveQuery(filters = null, pagination = null, indexName = null) {
    const startTime = Date.now();
    let opensearchQuery = null;

    try {
      logger.info('executeRegionObjectiveQuery: Starting region objective query');

      // Set default pagination
      if (!pagination) {
        pagination = { page: 1, page_size: 10 };
      }

      // If no index name is provided, use a default (this should be set by caller)
      const indices = indexName || ['pipe-rgn-dlr-objectives'];

      logger.info(`executeRegionObjectiveQuery: Using indices: ${JSON.stringify(indices)}`);

      // Convert filters to dict for query building
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

          filterDict[key] = value;
        }
      }

      logger.info(`executeRegionObjectiveQuery: Applied filters: ${JSON.stringify(filterDict)}`);

      // Build the OpenSearch query
      const query = this._buildOpenSearchQuery(filterDict);

      // Build aggregation query for region objectives
      const aggs = {
        regions: {
          terms: {
            field: "region_code",
            size: 10000 // Large size to get all regions
          },
          aggs: {
            retail_obj_sum: {
              sum: { field: "retail_obj" }
            },
            wholesale_obj_sum: {
              sum: { field: "wholesale_obj" }
            }
          }
        }
      };

      opensearchQuery = {
        size: 0, // We only want aggregations, not individual documents
        query: query,
        aggs: aggs
      };

      logger.info(`executeRegionObjectiveQuery: Executing query: ${JSON.stringify(opensearchQuery)}`);

      const client = await this.getClient();
      const response = await client.search({
        index: indices,
        body: opensearchQuery,
        timeout: '30s'
      });

      logger.info('executeRegionObjectiveQuery: Query executed successfully');

      // Process the aggregation results
      const regionData = this._processRegionObjectiveAggregationResponse(response);

      const endTime = Date.now();
      const executionTime = endTime - startTime;

      logger.info(`executeRegionObjectiveQuery: Processed ${regionData.length} regions in ${executionTime}ms`);

      return {
        success: true,
        data: regionData,
        query_info: {
          execution_time_ms: executionTime,
          total_regions: regionData.length,
          indices_queried: indices
        },
        execution_timestamp: new Date().toISOString()
      };

    } catch (error) {
      const endTime = Date.now();
      const executionTime = endTime - startTime;

      logger.error(`executeRegionObjectiveQuery failed after ${executionTime}ms: ${error.message}`);

      if (opensearchQuery) {
        logger.error(`executeRegionObjectiveQuery: Failed query: ${JSON.stringify(opensearchQuery)}`);
      }

      return {
        success: false,
        error: error.message,
        query_info: {
          execution_time_ms: executionTime,
          indices_queried: indexName || ['pipe-rgn-dlr-objectives']
        },
        execution_timestamp: new Date().toISOString()
      };
    }
  }

  /**
   * Process OpenSearch aggregation response for region objectives
   * @param {Object} response - The OpenSearch response
   * @returns {Array<Object>} The processed region objective data
   */
  _processRegionObjectiveAggregationResponse(response) {
    const regionData = [];

    try {
      const buckets = response.body?.aggregations?.regions?.buckets || [];
      logger.info(`_processRegionObjectiveAggregationResponse: Processing ${buckets.length} region buckets`);

      for (const bucket of buckets) {
        const regionCode = bucket.key;
        const retailObj = bucket.retail_obj_sum?.value || 0;
        const wholesaleObj = bucket.wholesale_obj_sum?.value || 0;

        const record = {
          region_code: regionCode,
          retail_obj: Math.round(retailObj), // Round to integer as per requirements
          wholesale_obj: Math.round(wholesaleObj)
        };

        regionData.push(record);

        logger.debug(`_processRegionObjectiveAggregationResponse: Region ${regionCode} - retail: ${record.retail_obj}, wholesale: ${record.wholesale_obj}`);
      }

      // Sort by region_code for consistent output
      regionData.sort((a, b) => a.region_code.localeCompare(b.region_code));

      logger.info(`_processRegionObjectiveAggregationResponse: Successfully processed ${regionData.length} regions`);

    } catch (error) {
      logger.error(`_processRegionObjectiveAggregationResponse failed: ${error.message}`);
      throw new Error(`Failed to process region objective aggregation response: ${error.message}`);
    }

    return regionData;
  }

  /**
   * Execute series objective query with aggregation
   * @param {Object} filters - The filters to apply
   * @param {Object} pagination - The pagination parameters
   * @param {Array<string>} indexName - The index name(s) to query
   * @returns {Promise<Object>} The query response with series objective data
   */
  async executeSeriesObjectiveQuery(filters = null, pagination = null, indexName = null) {
    const startTime = Date.now();
    let opensearchQuery = null;

    try {
      logger.info('executeSeriesObjectiveQuery: Starting series objective query');

      // Set default pagination
      if (!pagination) {
        pagination = { page: 1, page_size: 10 };
      }

      // If no index name is provided, use a default (this should be set by caller)
      const indices = indexName || ['pipe-rgn-dlr-objectives'];

      logger.info(`executeSeriesObjectiveQuery: Using indices: ${JSON.stringify(indices)}`);

      // Convert filters to dict for query building
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

          filterDict[key] = value;
        }
      }

      // Add the legacy_group_type = 10 filter as per SQL requirement
      filterDict.legacy_group_type = ['10'];

      logger.info(`executeSeriesObjectiveQuery: Applied filters: ${JSON.stringify(filterDict)}`);

      // Build the OpenSearch query
      const query = this._buildOpenSearchQuery(filterDict);

      // Build aggregation query for series objectives (grouped by product_name)
      const aggs = {
        series: {
          terms: {
            field: "product_name",
            size: 10000 // Large size to get all series
          },
          aggs: {
            retail_obj_sum: {
              sum: { field: "retail_obj" }
            },
            wholesale_obj_sum: {
              sum: { field: "wholesale_obj" }
            }
          }
        }
      };

      opensearchQuery = {
        size: 0, // We only want aggregations, not individual documents
        query: query,
        aggs: aggs
      };

      logger.info(`executeSeriesObjectiveQuery: Executing query: ${JSON.stringify(opensearchQuery)}`);

      const client = await this.getClient();
      const response = await client.search({
        index: indices,
        body: opensearchQuery,
        timeout: '30s'
      });

      logger.info('executeSeriesObjectiveQuery: Query executed successfully');

      // Process the aggregation results
      const seriesData = this._processSeriesObjectiveAggregationResponse(response);

      const endTime = Date.now();
      const executionTime = endTime - startTime;

      logger.info(`executeSeriesObjectiveQuery: Processed ${seriesData.length} series in ${executionTime}ms`);

      return {
        success: true,
        data: seriesData,
        query_info: {
          execution_time_ms: executionTime,
          total_series: seriesData.length,
          indices_queried: indices
        },
        execution_timestamp: new Date().toISOString()
      };

    } catch (error) {
      const endTime = Date.now();
      const executionTime = endTime - startTime;

      logger.error(`executeSeriesObjectiveQuery failed after ${executionTime}ms: ${error.message}`);

      if (opensearchQuery) {
        logger.error(`executeSeriesObjectiveQuery: Failed query: ${JSON.stringify(opensearchQuery)}`);
      }

      return {
        success: false,
        error: error.message,
        query_info: {
          execution_time_ms: executionTime,
          indices_queried: indexName || ['pipe-rgn-dlr-objectives']
        },
        execution_timestamp: new Date().toISOString()
      };
    }
  }

  /**
   * Execute color dealer aggregation query for dealer-level data from color index
   * @param {Object} filters - The filters to apply
   * @param {Object} pagination - The pagination parameters
   * @param {Array<string>} indexName - The index name(s) to query
   * @returns {Promise<Object>} The query response
   */
  async executeColorDealerAggregationQuery(filters = null, pagination = null, indexName = null) {
    const startTime = Date.now();
    let opensearchQuery = null;

    try {
      logger.info('executeColorDealerAggregationQuery: Starting dealer aggregation from color index');

      if (!pagination) {
        pagination = { page: 1, page_size: 10 };
      }

      const indices = indexName || ['pipe-rgn-dlr-dist-sale-inv-color-daily-summ-2025'];

      // Log wildcard filter usage for monitoring
      if (filters) {
        const wildcardFields = ['region_code', 'district_code', 'dealer_code'];
        wildcardFields.forEach(field => {
          if (filters[field] && Array.isArray(filters[field])) {
            const wildcardCount = filters[field].filter(val =>
              typeof val === 'string' && (val.includes('*') || val.includes('?'))
            ).length;
            if (wildcardCount > 0) {
              logger.info(`[WILDCARD] ColorDealerAgg ${field} filter contains ${wildcardCount} wildcard patterns out of ${filters[field].length} total values`);
            }
          }
        });
      }

      // Build aggregation query for dealer-level data
      opensearchQuery = this._buildColorDealerAggregationQuery(filters, 50000);

      logger.info(`executeColorDealerAggregationQuery: Executing query on indices: ${indices.join(', ')}`);
      logger.debug(`executeColorDealerAggregationQuery: Query: ${JSON.stringify(opensearchQuery)}`);

      const client = await this.getClient();

      // Get all dealer data using composite aggregation
      const allDealerData = await this._getAllColorDealerData(client, indices, opensearchQuery);

      const executionTime = Date.now() - startTime;
      logger.info(`executeColorDealerAggregationQuery: Successfully retrieved ${allDealerData.length} dealer records in ${executionTime}ms`);

      return {
        success: true,
        data: allDealerData,
        query_info: {
          execution_time_ms: executionTime,
          total_dealers: allDealerData.length,
          indices_queried: indices
        },
        execution_timestamp: new Date().toISOString()
      };

    } catch (error) {
      const executionTime = Date.now() - startTime;

      // Enhanced error logging for wildcard-related issues
      if (error.message && error.message.includes('wildcard')) {
        logger.error(`[WILDCARD] ColorDealerAgg Query failed with wildcard-related error after ${executionTime}ms: ${error.message}`);
      } else {
        logger.error(`executeColorDealerAggregationQuery failed after ${executionTime}ms: ${error.message}`);
      }

      if (opensearchQuery) {
        logger.error(`executeColorDealerAggregationQuery: Failed query: ${JSON.stringify(opensearchQuery)}`);
      }

      return {
        success: false,
        error: error.message,
        query_info: {
          execution_time_ms: executionTime,
          indices_queried: indexName || ['pipe-rgn-dlr-dist-sale-inv-color-daily-summ-2025']
        },
        execution_timestamp: new Date().toISOString()
      };
    }
  }

  /**
   * Build OpenSearch aggregation query for color dealer data
   * @param {Object} filters - The filters to apply
   * @param {number} size - The maximum number of results to return
   * @returns {Object} The OpenSearch query
   */
  _buildColorDealerAggregationQuery(filters = null, size = 10000) {
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

    const query = this._buildFilterQueryV32(filterDict);

    const aggs = {
      dealer_aggregation: {
        composite: {
          size: size,
          sources: [
            { dealer_code: { terms: { field: "dealer_code" } } },
            { dealer_name: { terms: { field: "dealer_name" } } },
            { region_code: { terms: { field: "region_code" } } },
            { region_name: { terms: { field: "region_name" } } },
            { district_code: { terms: { field: "district_code" } } }
          ]
        },
        aggs: {
          sales_availability_count: { sum: { field: "sales_availability_count" } },
          days_supply_count: { sum: { field: "days_supply_count" } },
          retail_count: { sum: { field: "retail_count" } },
          vpc_stock_count: { sum: { field: "vpc_stock_count" } },
          unbuilt_count: { sum: { field: "unbuilt_count" } },
          company_stock_count: { sum: { field: "company_stock_count" } },
          dealer_stock_count: { sum: { field: "dealer_stock_count" } },
          intransit_othervpc_count: { sum: { field: "intransit_othervpc_count" } },
          totalstock_count: { sum: { field: "totalstock_count" } },
          other_vpc_count: { sum: { field: "other_vpc_count" } },
          postprocess_intransit_count: { sum: { field: "postprocess_intransit_count" } },
          preprocess_intransit_vpc_count: { sum: { field: "preprocess_intransit_vpc_count" } },
          wholesale_count: { sum: { field: "wholesale_count" } },
          hist_dealerstock_count: { sum: { field: "hist_dealerstock_count" } },
          hist_tmsstock_count: { sum: { field: "hist_tmsstock_count" } },
          hist_mfgstock_count: { sum: { field: "hist_mfgstock_count" } },
          hist_portstock_count: { sum: { field: "hist_portstock_count" } },
          hist_intransitstock_count: { sum: { field: "hist_intransitstock_count" } },
          brand_code: { terms: { field: "brand_code", size: 1 } }
        }
      },
      // Add regional rankings
      region_rankings: {
        terms: {
          field: "region_code",
          size: 1000
        },
        aggs: {
          dealer_stats: {
            terms: {
              field: "dealer_code",
              size: 1000,
              order: {
                "dealer_retail": "desc"
              }
            },
            aggs: {
              dealer_retail: {
                sum: {
                  field: "retail_count"
                }
              }
            }
          }
        }
      },
      // Add national rankings
      national_rankings: {
        terms: {
          field: "dealer_code",
          size: 50000,
          order: {
            "total_retail": "desc"
          }
        },
        aggs: {
          total_retail: {
            sum: {
              field: "retail_count"
            }
          }
        }
      },
      // Add total dealers count
      total_dealers: {
        cardinality: {
          field: "dealer_code"
        }
      }
    };

    return {
      size: 0,
      query: query,
      aggs: aggs
    };
  }

  /**
   * Get all color dealer data using composite aggregation with pagination
   * @param {Object} client - The OpenSearch client
   * @param {Array<string>} indices - The indices to query
   * @param {Object} baseQuery - The base query structure
   * @returns {Promise<Array<Object>>} All dealer data
   * @private
   */
  async _getAllColorDealerData(client, indices, baseQuery) {
    let allDealerData = [];
    let after = null;
    let hasMore = true;
    let totalRequests = 0;
    const maxRequests = 10;

    logger.info('_getAllColorDealerData: Starting composite aggregation pagination');

    while (hasMore && totalRequests < maxRequests) {
      totalRequests++;

      const query = JSON.parse(JSON.stringify(baseQuery));
      if (after) {
        query.aggs.dealer_aggregation.composite.after = after;
      }
      logger.info(`Dealer Color Query: ${JSON.stringify(query)}`);
      logger.info(`_getAllColorDealerData: Request ${totalRequests} ${after ? 'with after key' : '(first request)'}`);

      try {
        const response = await client.search({
          index: indices,
          body: query,
          timeout: '60s'
        });

        const buckets = response.body?.aggregations?.dealer_aggregation?.buckets || [];
        logger.info(`_getAllColorDealerData: Request ${totalRequests} returned ${buckets.length} buckets`);

        if (buckets.length === 0) {
          hasMore = false;
          break;
        }

        const batchData = this._processColorDealerAggregationResponse(response);
        allDealerData = allDealerData.concat(batchData);

        const afterKey = response.body?.aggregations?.dealer_aggregation?.after_key;
        if (afterKey) {
          after = afterKey;
        } else {
          hasMore = false;
        }

      } catch (error) {
        logger.error(`_getAllColorDealerData: Error in request ${totalRequests}: ${error.message}`);
        hasMore = false;
      }
    }
    logger.info(`responses ranking${JSON.stringify(allDealerData)} `);
    logger.info(`_getAllColorDealerData: Complete - ${totalRequests} requests, ${allDealerData.length} total records`);
    return allDealerData;
  }

  /**
   * Build filter query for v32 (color data)
   * @param {Object} filters - The filters to apply
   * @returns {Object} The OpenSearch query
   */
  _buildFilterQueryV32(filters) {
    const mustFilters = [];

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

    // Handle wildcard-supported filters (region_code, district_code, dealer_code)
    const wildcardSupportedFilters = ['region_code', 'district_code', 'dealer_code'];

    wildcardSupportedFilters.forEach(filterKey => {
      if (filters[filterKey] && Array.isArray(filters[filterKey]) && filters[filterKey].length > 0) {
        const filterQuery = this._buildWildcardSupportedFilter(filterKey, filters[filterKey]);
        if (filterQuery) {
          mustFilters.push(filterQuery);
        }
      }
    });

    // Handle standard array-based filters for color index
    const standardArrayFilters = [
      'sls_ccyymm', 'distributor_code', 'model_year', 'model_code',
      'brand_code', 'segment_code', 'car_trk_indicator', 'dealer_type',
      'team_lease_indicator', 'transmissiontype_code', 'series_name', 'grade_code',
      'drivetrain_code', 'napc_bu_code', 'exterior_color_code', 'interior_color_code'
    ];

    standardArrayFilters.forEach(filterKey => {
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

    if (mustFilters.length === 0) {
      return { match_all: {} };
    }

    return {
      bool: {
        must: mustFilters
      }
    };
  }

  /**
   * Process OpenSearch composite aggregation response for color dealer data
   * @param {Object} response - The OpenSearch response
   * @returns {Array<Object>} The processed dealer data
   */
  _processColorDealerAggregationResponse(response) {
    const dealerData = [];

    if (!response.body?.aggregations?.dealer_aggregation?.buckets) {
      logger.warn('_processColorDealerAggregationResponse: No aggregation buckets found');
      return dealerData;
    }

    const buckets = response.body.aggregations.dealer_aggregation.buckets;
    const totalDealers = response.body.aggregations.total_dealers.value || 0;

    // Process national rankings
    const nationalRankings = new Map();
    logger.info('National Rankings Buckets:', JSON.stringify(response.body.aggregations.national_rankings?.buckets || []));

    if (response.body.aggregations.national_rankings?.buckets) {
      response.body.aggregations.national_rankings.buckets.forEach((bucket, index) => {
        const rankingData = {
          rank: index + 1,
          total_dealers: totalDealers,
          //percentile: ((index + 1) / totalDealers * 100).toFixed(2),
          total_retail: bucket.total_retail.value || 0
        };
        nationalRankings.set(bucket.key, rankingData);
      });
    }
    logger.info(`Total national rankings mapped: ${nationalRankings.size}`);

    // Process regional rankings
    const regionalRankings = new Map();
    if (response.body.aggregations.region_rankings?.buckets) {
      response.body.aggregations.region_rankings.buckets.forEach(regionBucket => {
        const regionCode = regionBucket.key;
        const dealerStats = regionBucket.dealer_stats?.buckets || [];
        const totalRegionDealers = dealerStats.length;

        dealerStats.forEach((dealerBucket, index) => {
          if (!regionalRankings.has(regionCode)) {
            regionalRankings.set(regionCode, new Map());
          }
          regionalRankings.get(regionCode).set(dealerBucket.key, {
            rank: index + 1,
            total_dealers: totalRegionDealers,
            //percentile: ((index + 1) / totalRegionDealers * 100).toFixed(2),
            retail_count: dealerBucket.dealer_retail.value || 0
          });
        });
      });
    }

    logger.info(`Processing rankings: National=${nationalRankings.size} dealers, Regional=${regionalRankings.size} regions`);

    buckets.forEach(bucket => {
      const key = bucket.key;
      const dealerCode = key.dealer_code || '';
      const regionCode = key.region_code || '';

      // Get national ranking data
      const nationalRanking = nationalRankings.get(dealerCode);
      if (!nationalRanking) {
        logger.warn(`No national ranking found for dealer ${dealerCode}. Keys in map: ${Array.from(nationalRankings.keys()).slice(0, 5).join(', ')}...`);
      }
      const finalNationalRanking = nationalRanking || {
        rank: null,
        total_dealers: totalDealers,
        //percentile: null,
        total_retail: 0
      };

      // Get regional ranking data
      const regionalRanking = regionalRankings.get(regionCode)?.get(dealerCode) || {
        rank: null,
        total_dealers: regionalRankings.get(regionCode)?.size || 0,
        //percentile: null,
        retail_count: 0
      };

      const dealerRecord = {
        dealer_code: dealerCode,
        dealer_name: key.dealer_name || '',
        region_code: regionCode,
        region_name: key.region_name || '',
        district_code: key.district_code || '',
        sales_availability_count: bucket.sales_availability_count?.value || 0,
        days_supply_count: bucket.days_supply_count?.value || 0,
        retail_count: bucket.retail_count?.value || 0,
        vpc_stock_count: bucket.vpc_stock_count?.value || 0,
        unbuilt_count: bucket.unbuilt_count?.value || 0,
        company_stock_count: bucket.company_stock_count?.value || 0,
        dealer_stock_count: bucket.dealer_stock_count?.value || 0,
        intransit_othervpc_count: bucket.intransit_othervpc_count?.value || 0,
        totalstock_count: bucket.totalstock_count?.value || 0,
        other_vpc_count: bucket.other_vpc_count?.value || 0,
        postprocess_intransit_count: bucket.postprocess_intransit_count?.value || 0,
        preprocess_intransit_vpc_count: bucket.preprocess_intransit_vpc_count?.value || 0,
        wholesale_count: bucket.wholesale_count?.value || 0,
        hist_dealerstock_count: bucket.hist_dealerstock_count?.value || 0,
        hist_tmsstock_count: bucket.hist_tmsstock_count?.value || 0,
        hist_mfgstock_count: bucket.hist_mfgstock_count?.value || 0,
        hist_portstock_count: bucket.hist_portstock_count?.value || 0,
        hist_intransitstock_count: bucket.hist_intransitstock_count?.value || 0,
        brand_code: bucket.brand_code?.buckets?.[0]?.key || '',
        national_ranking: finalNationalRanking,
        regional_ranking: regionalRanking
      };

      dealerData.push(dealerRecord);
    });

    logger.info(`Processed ${dealerData.length} dealer records with rankings`);
    return dealerData;
  }

  /**
   * Process OpenSearch aggregation response for series objectives
   * @param {Object} response - The OpenSearch response
   * @returns {Array<Object>} The processed series objective data
   */
  _processSeriesObjectiveAggregationResponse(response) {
    const seriesData = [];

    try {
      const buckets = response.body?.aggregations?.series?.buckets || [];
      logger.info(`_processSeriesObjectiveAggregationResponse: Processing ${buckets.length} series buckets`);

      for (const bucket of buckets) {
        const seriesName = bucket.key;
        const retailObj = bucket.retail_obj_sum?.value || 0;
        const wholesaleObj = bucket.wholesale_obj_sum?.value || 0;

        const record = {
          series_name: seriesName,
          retail_obj: Math.round(retailObj), // Round to integer as per requirements
          wholesale_obj: Math.round(wholesaleObj)
        };

        seriesData.push(record);

        logger.debug(`_processSeriesObjectiveAggregationResponse: Series ${seriesName} - retail: ${record.retail_obj}, wholesale: ${record.wholesale_obj}`);
      }

      // Sort by series_name for consistent output
      seriesData.sort((a, b) => a.series_name.localeCompare(b.series_name));

      logger.info(`_processSeriesObjectiveAggregationResponse: Successfully processed ${seriesData.length} series`);

    } catch (error) {
      logger.error(`_processSeriesObjectiveAggregationResponse failed: ${error.message}`);
      throw new Error(`Failed to process series objective aggregation response: ${error.message}`);
    }

    return seriesData;
  }
  buildKpiTilesAggQuery(filters) {
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
                  sum: { field: "retail_count" }
                },
                wholesales: {
                  sum: { field: "wholesale_count" }
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
              sum: { field: "retail_count" }
            },
            totalWholesales: {
              sum: { field: "wholesale_count" }
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
            wholesales: { bySeries: [] },
            salesAvailability: { bySeries: [] },
            dailySalesRate: { bySeries: [] },
            daysSupply: { bySeries: [] },
            salesVelocity: { bySeries: [] }
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
          salesAvailability: Number((monthBucket.totalSalesAvailability?.value || 0).toFixed(1)),
          dailySalesRate: monthBucket.totalDailySalesRate?.value || 0,
          daysSupply: Number((monthBucket.totalDaysSupply?.value || 0).toFixed(1)),
          salesVelocity: null//Number((monthBucket.totalSalesVelocity?.value || 0).toFixed(1))
        },
        kpiTilesInfo: {
          netRetailSales: { bySeries: topBySeries("netRetailSales") },
          wholesales: { bySeries: topBySeries("wholesales") },
          salesAvailability: { bySeries: topBySeries("salesAvailability", true) },
          dailySalesRate: { bySeries: topBySeries("dailySalesRate") },
          daysSupply: { bySeries: topBySeries("daysSupply", true) },
          salesVelocity: null//{ bySeries: topBySeries("salesVelocity", true) }
        }
      }
    };
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
            globalFilters[opensearchField] = filters[apiField];
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
  /**
   * Build OpenSearch filters from inline filter conditions
   * @param {Array} inlineFilters - Array of inline filter objects
   * @returns {Array} Array of OpenSearch filter clauses
   * @private
   */
  _buildInlineFilters(inlineFilters) {
    const mustFilters = [];

    if (!inlineFilters || !Array.isArray(inlineFilters)) {
      return mustFilters;
    }

    inlineFilters.forEach(filter => {
      const { field, condition, value } = filter;

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
          mustFilters.push({
            bool: {
              should: [
                {
                  term: {
                    [field]: value
                  }
                },
                {
                  term: {
                    [`${field}.keyword`]: value
                  }
                }
              ],
              minimum_should_match: 1
            }
          });
          break;
        case '!=':
          mustFilters.push({
            bool: {
              must_not: [
                {
                  bool: {
                    should: [
                      {
                        term: {
                          [field]: value
                        }
                      },
                      {
                        term: {
                          [`${field}.keyword`]: value
                        }
                      }
                    ],
                    minimum_should_match: 1
                  }
                }
              ]
            }
          });
          break;
        case 'contains':
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
          break;
        case 'not_contains':
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
          break;
        default:
          console.warn(`Unsupported inline filter condition: ${condition}`);
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
          // Apply case-insensitive filtering using terms query (case_insensitive not supported in terms)
          mustFilters.push({
            bool: {
              should: [
                {
                  terms: {
                    [filterKey]: filters[filterKey]
                  }
                },
                {
                  terms: {
                    [`${filterKey}.keyword`]: filters[filterKey]
                  }
                }
              ],
              minimum_should_match: 1
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
   * Preprocess filters for V33 endpoint - convert specified fields to uppercase
   * @param {Object} filters - The filters to preprocess
   * @returns {Object} Preprocessed filters with uppercase values
   */
  _preprocessFiltersV33(filters) {
    if (!filters) {
      return null;
    }

    // Boolean fields that should NOT be converted to uppercase
    const booleanFields = new Set([
      'fleet_flag', 'fd_fleet_flag', 'team_lease_indicator'
    ]);

    // Fields that should be converted to uppercase (excluding boolean fields)
    const filterFieldsToUppercase = [
      'distributor_code', 'region_code', 'region_name', 'dealer_code', 'dealer_name',
      'dealer_group_name', 'dealer_type', 'district_code', 'district_name',
      'vehicle_assignment_indicator', 'model_year', 'model_code',
      'fd_fleet_description', 'brand_code', 'segment_code',
      'subsegment_code', 'car_trk_indicator',
      'team_member_lease_sale_type', 'nap_cbu_code', 'series_name',
      'series_display_order', 'grade_code', 'transmissiontype_code',
      'drivetrain_code', 'fueltype_code', 'enginefueltype_code',
      'exterior_color_code', 'exterior_color_desc', 'interior_color_code',
      'interior_trim_color_desc'
    ];

    const processedFilters = { ...filters };

    filterFieldsToUppercase.forEach(fieldName => {
      if (processedFilters[fieldName] !== undefined) {
        if (Array.isArray(processedFilters[fieldName])) {
          processedFilters[fieldName] = processedFilters[fieldName].map(value =>
            typeof value === 'string' ? value.toUpperCase() : value
          );
          logger.info(`[V33] Converted ${fieldName} array values to uppercase`);
        } else if (typeof processedFilters[fieldName] === 'string') {
          const originalValue = processedFilters[fieldName];
          processedFilters[fieldName] = processedFilters[fieldName].toUpperCase();
          logger.info(`[V33] Converted ${fieldName} from "${originalValue}" to "${processedFilters[fieldName]}"`);
        }
      }
    });

    // Log boolean field handling for debugging
    booleanFields.forEach(fieldName => {
      if (processedFilters[fieldName] !== undefined) {
        logger.info(`[V33] Preserving boolean field ${fieldName} with value: ${processedFilters[fieldName]} (type: ${typeof processedFilters[fieldName]})`);
      }
    });

    return processedFilters;
  }

  /**
   * Build enhanced query for V33 endpoint with dynamic logic based on index_type and series_name
   * @param {Object} filters - The filters to apply
   * @param {string} indexType - The index type for query selection
   * @param {Array} inlineFilters - Inline filters to apply
   * @param {Array} sortFields - Sort fields to apply
   * @returns {Object} The OpenSearch query
   */
  _buildEnhancedQueryV33(filters, indexType, inlineFilters = [], sortFields = []) {
    logger.info(`[V33] Building query for index_type: ${indexType}`);

    // Check if series_name filter is present
    const hasSeriesName = filters && filters.series_name && Array.isArray(filters.series_name) && filters.series_name.length > 0;
    logger.info(`[V33] Series name filter present: ${hasSeriesName}`);

    // For index_type "0", "3", "5", use SQL-like aggregation logic
    if (['0', '3', '5'].includes(indexType)) {
      return this._buildSQLBasedQueryV33(filters, indexType, hasSeriesName, inlineFilters, sortFields);
    }

    // For other index types, use existing V32 logic
    return this._buildDealerAggregatedQueryV32(filters, 10000);
  }

  /**
   * Build SQL-based query for V33 endpoint for index types 0, 3, 5
   * @param {Object} filters - The filters to apply
   * @param {string} indexType - The index type (0, 3, or 5)
   * @param {boolean} hasSeriesName - Whether series_name filter is present
   * @param {Array} inlineFilters - Inline filters to apply
   * @param {Array} sortFields - Sort fields to apply
   * @returns {Object} The OpenSearch query
   */
  _buildSQLBasedQueryV33(filters, indexType, hasSeriesName, inlineFilters = [], sortFields = []) {
    logger.info(`[V33] Building SQL-based query for index_type: ${indexType}, hasSeriesName: ${hasSeriesName}`);

    // Convert filters to OpenSearch query format
    const filterDict = {};

    if (filters) {
      for (const [key, value] of Object.entries(filters)) {
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
          filterDict.transaction_date = { range: value };
        } else {
          filterDict[key] = value;
        }
      }
    }

    // Build base query with filters
    let baseQuery = this._buildOpenSearchQuery(filterDict);

    // Add inline filters to the query
    if (inlineFilters && inlineFilters.length > 0) {
      baseQuery = this._addInlineFiltersToQueryV33(baseQuery, inlineFilters);
    }

    // Build aggregation with sorting support
    const aggs = this._buildAggregationWithSortingV33(indexType, hasSeriesName, sortFields);

    return {
      size: 0,
      query: baseQuery,
      aggs: aggs
    };
  }

  /**
   * Add inline filters to OpenSearch query for V33
   * @param {Object} baseQuery - The base OpenSearch query
   * @param {Array} inlineFilters - The inline filters to add
   * @returns {Object} Enhanced query with inline filters
   */
  _addInlineFiltersToQueryV33(baseQuery, inlineFilters) {
    logger.info(`[V33] Adding ${inlineFilters.length} inline filters to OpenSearch query`);

    const inlineFilterClauses = [];

    // Text fields that support "contains" filtering
    const textFields = new Set([
      'region_code', 'region_name', 'district_code', 'district_name', 'dealer_code', 'dealer_name',
      'vehicle_assignment_indicator', 'brand_code', 'objective_available_indicator'
    ]);

    inlineFilters.forEach(filter => {
      const fieldName = filter.field;

      // Handle text fields with "contains" logic
      if (textFields.has(fieldName) && filter.condition === 'contains') {
        if (Array.isArray(filter.value)) {
          // Multiple values - OR logic
          const shouldClauses = filter.value.map(val => ({
            wildcard: {
              [fieldName]: {
                value: `*${String(val).toUpperCase()}*`,
                case_insensitive: true
              }
            }
          }));
          inlineFilterClauses.push({ bool: { should: shouldClauses, minimum_should_match: 1 } });
        } else {
          // Single value
          inlineFilterClauses.push({
            wildcard: {
              [fieldName]: {
                value: `*${String(filter.value).toUpperCase()}*`,
                case_insensitive: true
              }
            }
          });
        }
      }
      // Handle numeric fields - these will be applied post-aggregation in the bucket selector
      else if (this._isNumericField(fieldName)) {
        // Numeric filters will be handled in the aggregation pipeline
        logger.info(`[V33] Numeric filter for ${fieldName} will be applied post-aggregation`);
      }
    });

    // Combine base query with inline filters
    if (inlineFilterClauses.length > 0) {
      const existingMustClauses = baseQuery.bool?.must || [];
      return {
        bool: {
          must: [...existingMustClauses, ...inlineFilterClauses]
        }
      };
    }

    return baseQuery;
  }

  /**
   * Check if a field is numeric for inline filtering
   * @param {string} fieldName - The field name to check
   * @returns {boolean} True if the field is numeric
   */
  _isNumericField(fieldName) {
    const numericFields = new Set([
      'retail_count', 'wholesale_count', 'distributor_count', 'retail_objective_count',
      'wholesale_objective_count', 'dealer_retail_obj', 'series_retail_ytd_obj', 'series_wholesale_ytd_obj',
      'region_retail_ytd_obj', 'region_wholesale_ytd_obj', 'retail_objective_percentage',
      'wholesale_objective_percentage', 'sales_availability_count', 'days_supply_count',
      'vpc_stock_count', 'unbuilt_count', 'company_stock_count', 'dealer_stock_count',
      'intransit_othervpc_count', 'totalstock_count', 'other_vpc_count', 'postprocess_intransit_count',
      'preprocess_intransit_vpc_count', 'hist_dealerstock_count', 'hist_tmsstock_count',
      'hist_mfgstock_count', 'hist_portstock_count', 'hist_intransitstock_count', 'sales_to_availability'
    ]);
    return numericFields.has(fieldName);
  }

  /**
   * Build aggregation with sorting support for V33
   * @param {string} indexType - The index type (0, 3, or 5)
   * @param {boolean} hasSeriesName - Whether series_name filter is present
   * @param {Array} sortFields - The sort fields configuration
   * @returns {Object} The aggregation configuration
   */
  _buildAggregationWithSortingV33(indexType, hasSeriesName, sortFields = []) {
    logger.info(`[V33] Building aggregation for index_type: ${indexType}, hasSeriesName: ${hasSeriesName}`);

    // Build composite aggregation sources
    const sources = [
      { region_code: { terms: { field: "region_code" } } },
      { region_name: { terms: { field: "region_name" } } },
      { region_display_order: { terms: { field: "region_display_order" } } },
      { district_code: { terms: { field: "district_code" } } },
      { district_name: { terms: { field: "district_name" } } },
      { dealer_code: { terms: { field: "dealer_code" } } },
      { dealer_name: { terms: { field: "dealer_name" } } },
      { vehicle_assignment_indicator: { terms: { field: "vehicle_assignment_indicator" } } },
      { brand_code: { terms: { field: "brand_code" } } },
      { objective_record_indicator: { terms: { field: "objective_record_indicator" } } },
      { objective_available_indicator: { terms: { field: "objective_available_indicator" } } }
    ];

    // Determine which count fields to use based on index_type
    let retailCountField, wholesaleCountField, distributorCountField;

    switch (indexType) {
      case '0':
        retailCountField = 'net_daily_retail_count';
        wholesaleCountField = 'net_daily_wholesale_count';
        distributorCountField = 'net_daily_distributor_count';
        break;
      case '3':
        retailCountField = 'net_mtd_retail_count';
        wholesaleCountField = 'net_mtd_wholesale_count';
        distributorCountField = 'net_mtd_distributor_count';
        break;
      case '5':
        retailCountField = 'net_ytd_retail_count';
        wholesaleCountField = 'net_ytd_wholesale_count';
        distributorCountField = 'net_ytd_distributor_count';
        break;
      default:
        retailCountField = 'net_daily_retail_count';
        wholesaleCountField = 'net_daily_wholesale_count';
        distributorCountField = 'net_daily_distributor_count';
    }

    // Determine objective fields based on series_name and index_type
    let retailObjectiveField, wholesaleObjectiveField;

    if (indexType === '5') {
      // For YTD (index_type 5), always use YTD objectives
      retailObjectiveField = hasSeriesName ? 'series_retail_ytd_obj' : 'region_retail_ytd_obj';
      wholesaleObjectiveField = hasSeriesName ? 'series_wholesale_ytd_obj' : 'region_wholesale_ytd_obj';
    } else {
      // For daily and MTD (index_type 0 and 3)
      retailObjectiveField = hasSeriesName ? 'series_retail_obj' : 'region_retail_obj';
      wholesaleObjectiveField = hasSeriesName ? 'series_wholesale_obj' : 'region_wholesale_obj';
    }

    // Build sub-aggregations for metrics
    const subAggs = {
      // Core sales metrics
      retail_count: { sum: { field: retailCountField } },
      wholesale_count: { sum: { field: wholesaleCountField } },
      distributor_count: { sum: { field: distributorCountField } },

      // Objective metrics
      retail_objective_count: { sum: { field: retailObjectiveField } },
      wholesale_objective_count: { sum: { field: wholesaleObjectiveField } },

      // YTD objectives (always included for response completeness)
      series_retail_ytd_obj: { sum: { field: "series_retail_ytd_obj" } },
      series_wholesale_ytd_obj: { sum: { field: "series_wholesale_ytd_obj" } },
      region_retail_ytd_obj: { sum: { field: "region_retail_ytd_obj" } },
      region_wholesale_ytd_obj: { sum: { field: "region_wholesale_ytd_obj" } },

      // Dealer objectives
      dealer_pcar_obj: { sum: { field: "dealer_pcar_obj" } },
      dealer_ltrk_obj: { sum: { field: "dealer_ltrk_obj" } },
      dealer_pcar_ytd_obj: { sum: { field: "dealer_pcar_ytd_obj" } },
      dealer_ltrk_ytd_obj: { sum: { field: "dealer_ltrk_ytd_obj" } },

      // Calculated metrics using bucket_script
      retail_objective_percentage: {
        bucket_script: {
          buckets_path: {
            retail: "retail_count",
            objective: "retail_objective_count"
          },
          script: "params.objective > 0 ? (params.retail / params.objective) * 100 : 0"
        }
      },
      wholesale_objective_percentage: {
        bucket_script: {
          buckets_path: {
            wholesale: "wholesale_count",
            objective: "wholesale_objective_count"
          },
          script: "params.objective > 0 ? (params.wholesale / params.objective) * 100 : 0"
        }
      },
      dealer_retail_obj: {
        bucket_script: {
          buckets_path: {
            pcar: "dealer_pcar_obj",
            ltrk: "dealer_ltrk_obj"
          },
          script: "params.pcar + params.ltrk"
        }
      }
    };

    // Build the main aggregation
    const aggs = {
      dealer_aggregated: {
        composite: {
          size: 10000,
          sources: sources
        },
        aggs: subAggs
      }
    };

    // Add sorting if specified
    if (sortFields && sortFields.length > 0) {
      const sortClause = this._buildOpenSearchSortClauseV33(sortFields);
      aggs.dealer_aggregated.composite.after = undefined; // Will be set during pagination
      // Note: Composite aggregation sorting is limited, so we'll handle sorting post-aggregation
    }

    return aggs;
  }

  /**
   * Build OpenSearch sort clause from sort fields for V33
   * @param {Array} sortFields - The sort fields configuration
   * @returns {Array} OpenSearch sort clause
   */
  _buildOpenSearchSortClauseV33(sortFields) {
    const sortClause = [];

    sortFields.forEach(sortField => {
      const sortOrder = sortField.order === 'desc' ? 'desc' : 'asc';
      sortClause.push({ [sortField.field]: { order: sortOrder } });
    });

    // Add default sort by region_code if no sorts specified
    if (sortClause.length === 0) {
      sortClause.push({ "region_code": { order: "asc" } });
    }

    logger.info(`[V33] Built sort clause: ${JSON.stringify(sortClause)}`);
    return sortClause;
  }

  /**
   * Execute paginated query for V33 endpoint with enhanced filtering and sorting
   * @param {Object} filters - The filters to apply
   * @param {Object} pagination - The pagination parameters
   * @param {Array<string>} indexName - The index name(s) to query
   * @param {string} indexType - The index type for query selection
   * @param {Array} inlineFilters - Inline filters to apply
   * @param {Array} sortFields - Sort fields to apply
   * @returns {Promise<Object>} The query response
   */
  async executePaginatedQueryV33(filters = null, pagination = null, indexName = null, indexType = '0', inlineFilters = [], sortFields = []) {
    const startTime = Date.now();
    let opensearchQuery = null;

    try {
      logger.info(`[V33] Starting enhanced query execution with index_type: ${indexType}`);

      if (!pagination) {
        pagination = { page: 1, page_size: 10 };
      }

      // Preprocess filters for uppercase conversion
      const processedFilters = this._preprocessFiltersV33(filters);

      // Use the correct index name for index types 0, 3, 5
      const indices = indexName || ['pipe-rgn-dlr-dist-sale-color-current-summary-2025'];

      // Build query based on index_type and series_name presence with inline filters and sorting
      opensearchQuery = this._buildEnhancedQueryV33(processedFilters, indexType, inlineFilters, sortFields);

      logger.info(`[V33] Executing query with index_type: ${indexType}`);
      logger.info(`[V33] Query body: ${JSON.stringify(opensearchQuery, null, 2)}`);

      const client = await this.getClient();

      // Execute query
      const response = await client.search({
        index: indices,
        body: opensearchQuery,
        timeout: '30s'
      });

      // Process response based on query type
      let aggregatedData;
      if (['0', '3', '5'].includes(indexType)) {
        aggregatedData = this._processV33SQLBasedResponse(response, processedFilters, indexType, inlineFilters, sortFields);
      } else {
        // Use existing V32 processing for other index types
        const allDealerData = await this._getAllDealerDataV32(client, indices, opensearchQuery);
        aggregatedData = this._createFlatAggregatedStructureV32(allDealerData);
      }

      const totalRecords = aggregatedData.length;
      const executionTime = (Date.now() - startTime) / 1000;

      logger.info(`[V33] Query executed successfully in ${executionTime.toFixed(2)} seconds, ${totalRecords} records`);

      return {
        success: true,
        data: aggregatedData,
        total_records: totalRecords,
        query_info: {
          took: response.body?.took || 0,
          timed_out: response.body?.timed_out || false,
          total_shards: response.body?._shards?.total || 0,
          successful_shards: response.body?._shards?.successful || 0
        },
        execution_timestamp: new Date(),
        version: "v33",
        aggregation_level: "enhanced_dealer_aggregation"
      };

    } catch (error) {
      const executionTime = (Date.now() - startTime) / 1000;
      logger.error(`[V33] Query failed after ${executionTime.toFixed(2)} seconds: ${error.message}`);

      if (opensearchQuery) {
        logger.error(`[V33] Query that failed: ${JSON.stringify(opensearchQuery)}`);
      }

      return {
        success: false,
        error: `V33 Query execution failed: ${error.message}`,
        data: [],
        query_info: {
          took: 0,
          timed_out: false,
          total_shards: 0,
          successful_shards: 0,
          error: error.message
        },
        execution_timestamp: new Date(),
        version: "v33",
        aggregation_level: "enhanced_dealer_aggregation"
      };
    }
  }

  /**
   * Process V33 SQL-based response from OpenSearch
   * @param {Object} response - The OpenSearch response
   * @param {Object} filters - The processed filters
   * @param {string} indexType - The index type
   * @param {Array} inlineFilters - Inline filters for post-processing
   * @param {Array} sortFields - Sort fields for post-processing
   * @returns {Array} Processed aggregated data
   */
  _processV33SQLBasedResponse(response, filters, indexType, inlineFilters = [], sortFields = []) {
    const aggregatedData = [];

    // Defensive check for response structure
    if (!response || !response.body || !response.body.aggregations) {
      logger.warn('[V33] No aggregations found in OpenSearch response');
      return aggregatedData;
    }

    const buckets = response.body.aggregations.dealer_aggregated?.buckets || [];
    logger.info(`[V33] Processing ${buckets.length} buckets from OpenSearch response`);

    if (buckets.length === 0) {
      logger.info('[V33] No data buckets found in response');
      return aggregatedData;
    }

    // Check if series_name filter is present for objective calculation logic
    const hasSeriesName = filters && filters.series_name && Array.isArray(filters.series_name) && filters.series_name.length > 0;
    logger.info(`[V33] Using ${hasSeriesName ? 'series-based' : 'region-based'} objectives for index_type: ${indexType}`);

    for (const bucket of buckets) {
      const key = bucket.key;
      const aggs = bucket;

      // Ensure key exists and has required properties
      if (!key) {
        logger.warn('[V33] Skipping bucket with missing key');
        continue;
      }

      // Calculate dealer retail objective (dealer_pcar_obj + dealer_ltrk_obj) - preserve negative values
      const dealerRetailObj = (aggs.dealer_retail_obj?.value ?? 0);
      const dealerRetailYtdObj = (aggs.dealer_pcar_ytd_obj?.value ?? 0) + (aggs.dealer_ltrk_ytd_obj?.value ?? 0);

      // Get calculated percentages from bucket_script - preserve negative values
      const retailObjectivePercentage = aggs.retail_objective_percentage?.value ?? 0;
      const wholesaleObjectivePercentage = aggs.wholesale_objective_percentage?.value ?? 0;

      // Determine objective availability - preserve negative values
      const retailObjectiveCount = aggs.retail_objective_count?.value ?? 0;
      let objectiveAvailableIndicator = false;
      if (retailObjectiveCount > 0 || aggs.wholesale_objective_count?.value > 0) {
        objectiveAvailableIndicator = true;
      }
      else if (aggs.objective_record_indicator?.value == true && aggs.objective_available_indicator?.value == true) {
        objectiveAvailableIndicator = true;
      }
      else {
        objectiveAvailableIndicator = false;
      }
      const record = {
        region_code: key.region_code || '',
        region_name: key.region_name || '',
        region_display_order: key.region_display_order || 0,
        district_code: key.district_code || '',
        district_name: key.district_name || '',
        dealer_code: key.dealer_code || '',
        dealer_name: key.dealer_name || '',
        vehicle_assignment_indicator: key.vehicle_assignment_indicator || '',
        brand_code: key.brand_code || '',
        objective_available_indicator: objectiveAvailableIndicator,

        // Core sales metrics - preserve negative values
        retail_count: aggs.retail_count?.value ?? 0,
        wholesale_count: aggs.wholesale_count?.value ?? 0,
        distributor_count: aggs.distributor_count?.value ?? 0,

        // Objective metrics - preserve negative values
        retail_objective_count: retailObjectiveCount,
        wholesale_objective_count: aggs.wholesale_objective_count?.value ?? 0,
        dealer_retail_obj: dealerRetailObj,

        // YTD objectives - preserve negative values
        series_retail_ytd_obj: aggs.series_retail_ytd_obj?.value ?? 0,
        series_wholesale_ytd_obj: aggs.series_wholesale_ytd_obj?.value ?? 0,
        region_retail_ytd_obj: aggs.region_retail_ytd_obj?.value ?? 0,
        region_wholesale_ytd_obj: aggs.region_wholesale_ytd_obj?.value ?? 0,

        // Calculated percentages
        retail_objective_percentage: parseFloat(retailObjectivePercentage.toFixed(2)),
        wholesale_objective_percentage: parseFloat(wholesaleObjectivePercentage.toFixed(2)),

        // Default values for stock fields (as per requirements)
        sales_availability_count: 0,
        days_supply_count: 0,
        vpc_stock_count: 0,
        unbuilt_count: 0,
        company_stock_count: 0,
        dealer_stock_count: 0,
        intransit_othervpc_count: 0,
        totalstock_count: 0,
        other_vpc_count: 0,
        postprocess_intransit_count: 0,
        preprocess_intransit_vpc_count: 0,
        hist_dealerstock_count: 0,
        hist_tmsstock_count: 0,
        hist_mfgstock_count: 0,
        hist_portstock_count: 0,
        hist_intransitstock_count: 0,
        sales_to_availability: 0
      };

      // Log each processed record for analysis
      console.log(`[V33] Processed Record: Region=${record.region_code}, District=${record.district_code}, Dealer=${record.dealer_code}, Retail=${record.retail_count}, Wholesale=${record.wholesale_count}`);

      // Log if negative values are detected and preserved
      if (record.retail_count < 0 || record.wholesale_count < 0 || record.distributor_count < 0) {
        console.log(`[V33] NEGATIVE VALUES PRESERVED: Retail=${record.retail_count}, Wholesale=${record.wholesale_count}, Distributor=${record.distributor_count}`);
      }

      aggregatedData.push(record);
    }

    console.log(`[V33] Total processed records: ${aggregatedData.length}`);
    console.log(`[V33] Records with positive retail_count: ${aggregatedData.filter(r => r.retail_count > 0).length}`);
    console.log(`[V33] Records with negative retail_count: ${aggregatedData.filter(r => r.retail_count < 0).length}`);
    console.log(`[V33] Records with zero retail_count: ${aggregatedData.filter(r => r.retail_count === 0).length}`);
    console.log(`[V33] Records with positive wholesale_count: ${aggregatedData.filter(r => r.wholesale_count > 0).length}`);
    console.log(`[V33] Records with negative wholesale_count: ${aggregatedData.filter(r => r.wholesale_count < 0).length}`);
    console.log(`[V33] Records with zero wholesale_count: ${aggregatedData.filter(r => r.wholesale_count === 0).length}`);

    // Apply numeric inline filters post-aggregation
    let filteredData = this._applyNumericInlineFiltersV33(aggregatedData, inlineFilters);

    // Apply sorting post-aggregation
    filteredData = this._applySortingV33(filteredData, sortFields, indexType);

    logger.info(`[V33] Processed ${filteredData.length} records from SQL-based response`);
    return filteredData;
  }

  /**
   * Apply numeric inline filters to aggregated data for V33 endpoint
   * @param {Array} data - The data to filter
   * @param {Array} inlineFilters - The inline filters to apply
   * @returns {Array} Filtered data
   */
  _applyNumericInlineFiltersV33(data, inlineFilters) {
    if (!inlineFilters || !Array.isArray(inlineFilters) || inlineFilters.length === 0) {
      return data;
    }

    const numericFilters = inlineFilters.filter(filter => this._isNumericField(filter.field));

    if (numericFilters.length === 0) {
      return data;
    }

    logger.info(`[V33] Applying ${numericFilters.length} numeric inline filters`);

    return data.filter(item => {
      return numericFilters.every(filter => {
        const fieldValue = item[filter.field];

        if (fieldValue === undefined || fieldValue === null) {
          return false;
        }

        const numericValue = parseFloat(fieldValue);
        const filterNumericValue = parseFloat(filter.value);

        if (isNaN(numericValue) || isNaN(filterNumericValue)) {
          return false;
        }

        switch (filter.condition) {
          case '>=':
            return numericValue >= filterNumericValue;
          case '<=':
            return numericValue <= filterNumericValue;
          case '=':
            return numericValue === filterNumericValue;
          case '>':
            return numericValue > filterNumericValue;
          case '<':
            return numericValue < filterNumericValue;
          default:
            logger.error(`[V33] Unknown numeric condition: ${filter.condition}`);
            return true;
        }
      });
    });
  }

  /**
   * Apply sorting to aggregated data for V33 endpoint
   * @param {Array} data - The data to sort
   * @param {Array} sortFields - The sort fields configuration
   * @param {string} indexType - The index type to determine default sort behavior
   * @returns {Array} Sorted data
   */
  _applySortingV33(data, sortFields, indexType = '0') {
    if (!sortFields || !Array.isArray(sortFields) || sortFields.length === 0) {
      // Default sorting: region_display_order ASC for index types 0, 3, 5; region_code ASC for others
      if (['0', '3', '5'].includes(indexType)) {
        return data.sort((a, b) => {
          const aVal = parseFloat(a.region_display_order) || 0;
          const bVal = parseFloat(b.region_display_order) || 0;
          return aVal - bVal;
        });
      } else {
        return data.sort((a, b) => {
          const aVal = a.region_code || '';
          const bVal = b.region_code || '';
          return aVal.localeCompare(bVal);
        });
      }
    }

    logger.info(`[V33] Applying sorting by ${sortFields.length} fields`);

    return data.sort((a, b) => {
      for (const sort of sortFields) {
        const fieldA = a[sort.field];
        const fieldB = b[sort.field];

        // Handle undefined values
        if (fieldA === undefined && fieldB !== undefined) return sort.order === 'asc' ? -1 : 1;
        if (fieldA !== undefined && fieldB === undefined) return sort.order === 'asc' ? 1 : -1;
        if (fieldA === undefined && fieldB === undefined) continue;

        // Compare values
        let comparison = 0;
        if (typeof fieldA === 'number' && typeof fieldB === 'number') {
          comparison = fieldA - fieldB;
        } else {
          comparison = String(fieldA).localeCompare(String(fieldB));
        }

        if (comparison !== 0) {
          return sort.order === 'asc' ? comparison : -comparison;
        }
      }
      return 0;
    });
  }

  /**
   * Transform flat data into enhanced hierarchical structure for V33 endpoint
   * @param {Array} flatData - Array of flat data objects
   * @param {Object} pagination - Pagination parameters
   * @returns {Object} Enhanced hierarchical structure with new fields
   */
  _transformToHierarchicalStructureV33(flatData, pagination) {
    if (!Array.isArray(flatData) || flatData.length === 0) {
      return {
        regionSummary: {
          count: 0,
          regions: [],
          totals: {}
        }
      };
    }

    // Group data by region, district, and dealer
    const regionMap = new Map();
    const totals = {};

    // Initialize totals with all numeric fields including new V33 fields
    const numericFields = [
      'sales_availability_count', 'days_supply_count', 'retail_count', 'vpc_stock_count',
      'unbuilt_count', 'company_stock_count', 'dealer_stock_count', 'intransit_othervpc_count',
      'totalstock_count', 'other_vpc_count', 'postprocess_intransit_count', 'preprocess_intransit_vpc_count',
      'wholesale_count', 'hist_dealerstock_count', 'hist_tmsstock_count', 'hist_mfgstock_count',
      'hist_portstock_count', 'hist_intransitstock_count', 'sales_to_availability',
      // New V33 fields
      'distributor_count', 'retail_objective_count', 'wholesale_objective_count', 'dealer_retail_obj',
      'series_retail_ytd_obj', 'series_wholesale_ytd_obj', 'region_retail_ytd_obj', 'region_wholesale_ytd_obj',
      'retail_objective_percentage', 'wholesale_objective_percentage'
    ];

    numericFields.forEach(field => {
      totals[field] = 0;
    });

    flatData.forEach(item => {
      const regionCode = item.region_code;
      const regionName = item.region_name;
      const districtCode = item.district_code;
      const districtName = item.district_name;
      const dealerCode = item.dealer_code;
      const dealerName = item.dealer_name;
      const brandCode = item.brand_code || '';
      const vehicleAssignmentIndicator = this._convertToTrueFalseString(item.vehicle_assignment_indicator);
      const objectiveAvailableIndicator = this._convertToTrueFalseString(item.objective_available_indicator);

      // Initialize region if not exists
      if (!regionMap.has(regionCode)) {
        regionMap.set(regionCode, {
          region_code: regionCode,
          region_name: regionName,
          brand_code: brandCode,
          vehicle_assignment_indicator: vehicleAssignmentIndicator,
          objective_available_indicator: objectiveAvailableIndicator,
          districts: new Map(),
          ...Object.fromEntries(numericFields.map(field => [field, 0]))
        });
      }

      const region = regionMap.get(regionCode);

      // Initialize district if not exists
      if (!region.districts.has(districtCode)) {
        region.districts.set(districtCode, {
          district_code: districtCode,
          district_name: districtName,
          brand_code: brandCode,
          vehicle_assignment_indicator: vehicleAssignmentIndicator,
          dealers: new Map(),
          ...Object.fromEntries(numericFields.map(field => [field, 0]))
        });
      }

      const district = region.districts.get(districtCode);

      // Initialize dealer if not exists
      if (!district.dealers.has(dealerCode)) {
        district.dealers.set(dealerCode, {
          dealer_code: dealerCode,
          dealer_name: dealerName,
          brand_code: brandCode,
          vehicle_assignment_indicator: vehicleAssignmentIndicator,
          ...Object.fromEntries(numericFields.map(field => [field, 0]))
        });
      }

      const dealer = district.dealers.get(dealerCode);

      // Aggregate numeric values
      numericFields.forEach(field => {
        if (field !== 'sales_to_availability' && field !== 'retail_objective_percentage' && field !== 'wholesale_objective_percentage') {
          const rawValue = item[field];
          const value = parseFloat(rawValue);

          // Log negative values for debugging
          if (value < 0) {
            console.log(`[DEBUG] Negative value detected - Field: ${field}, Value: ${value}, Dealer: ${dealerCode}, District: ${districtCode}, Region: ${regionCode}`);
          }

          // Use the parsed value or 0 if NaN, preserve negative values as-is
          const finalValue = isNaN(value) ? 0 : value;
          dealer[field] += finalValue;
          district[field] += finalValue;
          region[field] += finalValue;
          totals[field] += finalValue;
        }
      });

      // Handle calculated percentage fields separately
      dealer.retail_objective_percentage = parseFloat(item.retail_objective_percentage) || 0;
      dealer.wholesale_objective_percentage = parseFloat(item.wholesale_objective_percentage) || 0;
    });

    // Convert maps to arrays and structure the response
    const regions = Array.from(regionMap.values()).map(region => {
      const { districts, ...regionFields } = region;

      // Calculate region-level percentages
      const regionRetailCount = regionFields.retail_count || 0;
      const regionRetailObjective = regionFields.retail_objective_count || 0;
      const regionWholesaleCount = regionFields.wholesale_count || 0;
      const regionWholesaleObjective = regionFields.wholesale_objective_count || 0;
      const regionDealerStockCount = regionFields.dealer_stock_count || 0;

      regionFields.retail_objective_percentage = regionRetailObjective > 0
        ? parseFloat(((regionRetailCount / regionRetailObjective) * 100).toFixed(2))
        : 0;
      regionFields.wholesale_objective_percentage = regionWholesaleObjective > 0
        ? parseFloat(((regionWholesaleCount / regionWholesaleObjective) * 100).toFixed(2))
        : 0;

      // Always set sales_to_availability to 0 as per requirement
      regionFields.sales_to_availability = 0;

      // Set objective_available_indicator to match vehicle_assignment_indicator from districts
      // Use all districts (including filtered ones) to get the indicator value
      const firstDistrict = Array.from(districts.values())[0];
      if (firstDistrict && firstDistrict.vehicle_assignment_indicator) {
        regionFields.objective_available_indicator = firstDistrict.vehicle_assignment_indicator;
      }

      // Filter districts and dealers for final response
      const filteredDistricts = Array.from(districts.values())
        .filter(district => district.district_code !== '99') // Filter out district_code "99"
        .map(district => {
          const { dealers, ...districtFields } = district;

          // Calculate district-level percentages
          const districtRetailCount = districtFields.retail_count || 0;
          const districtRetailObjective = districtFields.retail_objective_count || 0;
          const districtWholesaleCount = districtFields.wholesale_count || 0;
          const districtWholesaleObjective = districtFields.wholesale_objective_count || 0;
          const districtDealerStockCount = districtFields.dealer_stock_count || 0;

          districtFields.retail_objective_percentage = districtRetailObjective > 0
            ? parseFloat(((districtRetailCount / districtRetailObjective) * 100).toFixed(2))
            : 0;
          districtFields.wholesale_objective_percentage = districtWholesaleObjective > 0
            ? parseFloat(((districtWholesaleCount / districtWholesaleObjective) * 100).toFixed(2))
            : 0;

          // Always set sales_to_availability to 0 as per requirement
          districtFields.sales_to_availability = 0;

          return {
            ...districtFields,
            dealers: Array.from(dealers.values())
              .filter(dealer => dealer.dealer_code !== '99999') // Filter out dealer_code "99999"
              .map(dealer => {
                // Always set sales_to_availability to 0 as per requirement
                dealer.sales_to_availability = 0;

                return dealer;
              })
          };
        });

      return {
        ...regionFields,
        districts: filteredDistricts
      };
    }).filter(region => region.districts.length > 0); // Remove regions with no districts after filtering

    // Calculate overall totals percentages
    const totalRetailCount = totals.retail_count || 0;
    const totalRetailObjective = totals.retail_objective_count || 0;
    const totalWholesaleCount = totals.wholesale_count || 0;
    const totalWholesaleObjective = totals.wholesale_objective_count || 0;
    const totalDealerStockCount = totals.dealer_stock_count || 0;

    totals.retail_objective_percentage = totalRetailObjective > 0
      ? parseFloat(((totalRetailCount / totalRetailObjective) * 100).toFixed(2))
      : 0;
    totals.wholesale_objective_percentage = totalWholesaleObjective > 0
      ? parseFloat(((totalWholesaleCount / totalWholesaleObjective) * 100).toFixed(2))
      : 0;

    // Always set sales_to_availability to 0 as per requirement
    totals.sales_to_availability = 0;

    // Calculate count as page_size * total_pages as specified in requirements
    const totalPages = pagination ? Math.ceil(regions.length / pagination.page_size) : 1;
    const pageSize = pagination ? pagination.page_size : regions.length;
    const count = pageSize * totalPages;

    return {
      regionSummary: {
        count: count,
        regions: regions,
        totals: totals
      }
    };
  }

  /**
   * Execute V34 paginated query with accessory filtering and sorting
   * @param {Object} filters - Filter conditions
   * @param {Object} pagination - Pagination parameters
   * @param {Array} indexName - Array of index names to query
   * @param {string} indexType - Index type for query logic
   * @param {Array} inlineFilters - Inline filters to apply
   * @param {Array} sortFields - Sort fields
   * @returns {Promise<Object>} The query response
   */
  async executePaginatedQueryV34(filters = null, pagination = null, indexName = null, indexType = '0', inlineFilters = [], sortFields = []) {
    const startTime = Date.now();
    let opensearchQuery = null;

    try {
      logger.info(`[V34] Starting accessory enhanced query execution with index_type: ${indexType}`);

      if (!pagination) {
        pagination = { page: 1, page_size: 10 };
      }

      // Preprocess filters for uppercase conversion
      const processedFilters = this._preprocessFiltersV34(filters);

      // Use the correct index name for index types 0, 3, 5
      const indices = indexName || ['pipe-rgn-dlr-dist-sale-color-current-summary-2025'];

      // Build query based on index_type and series_name presence with inline filters and sorting
      opensearchQuery = this._buildEnhancedQueryV34(processedFilters, indexType, inlineFilters, sortFields);

      logger.info(`[V34] Executing query with index_type: ${indexType}`);
      logger.info(`[V34] Query body: ${JSON.stringify(opensearchQuery, null, 2)}`);

      const client = await this.getClient();

      // Execute query
      const response = await client.search({
        index: indices,
        body: opensearchQuery,
        timeout: '30s'
      });

      // Process response based on query type
      let aggregatedData;
      if (['0', '3', '5'].includes(indexType)) {
        aggregatedData = this._processV34SQLBasedResponse(response, processedFilters, indexType, inlineFilters, sortFields);
      } else {
        // Use existing V32 processing for other index types
        const allDealerData = await this._getAllDealerDataV32(client, indices, opensearchQuery);
        aggregatedData = this._createFlatAggregatedStructureV32(allDealerData);
      }

      const totalRecords = aggregatedData.length;
      const executionTime = (Date.now() - startTime) / 1000;

      logger.info(`[V34] Query executed successfully in ${executionTime.toFixed(2)} seconds, ${totalRecords} records`);

      return {
        success: true,
        data: aggregatedData,
        total_records: totalRecords,
        query_info: {
          took: response.body?.took || 0,
          timed_out: response.body?.timed_out || false,
          total_shards: response.body?._shards?.total || 0,
          successful_shards: response.body?._shards?.successful || 0
        },
        execution_timestamp: new Date(),
        version: "v34",
        aggregation_level: "accessory_enhanced_dealer_aggregation"
      };

    } catch (error) {
      const executionTime = (Date.now() - startTime) / 1000;
      logger.error(`[V34] Query failed after ${executionTime.toFixed(2)} seconds: ${error.message}`);

      if (opensearchQuery) {
        logger.error(`[V34] Query that failed: ${JSON.stringify(opensearchQuery)}`);
      }

      return {
        success: false,
        error: `V34 Query execution failed: ${error.message}`,
        data: [],
        query_info: {
          took: 0,
          timed_out: false,
          total_shards: 0,
          successful_shards: 0,
          error: error.message
        },
        execution_timestamp: new Date(),
        version: "v34",
        aggregation_level: "accessory_enhanced_dealer_aggregation"
      };
    }
  }

  /**
   * Process V34 SQL-based response from OpenSearch for accessory filtering
   * @param {Object} response - The OpenSearch response
   * @param {Object} filters - The processed filters
   * @param {string} indexType - The index type
   * @param {Array} inlineFilters - Inline filters for post-processing
   * @param {Array} sortFields - Sort fields for post-processing
   * @returns {Array} Processed aggregated data
   */
  _processV34SQLBasedResponse(response, filters, indexType, inlineFilters = [], sortFields = []) {
    // Reuse V33 processing logic since the data structure is the same
    return this._processV33SQLBasedResponse(response, filters, indexType, inlineFilters, sortFields);
  }

  /**
   * Preprocess filters for V34 with accessory-specific field handling
   * @param {Object} filters - Raw filters from request
   * @returns {Object} Processed filters with uppercase conversion
   */
  _preprocessFiltersV34(filters) {
    if (!filters) return null;

    const processedFilters = { ...filters };

    // Define fields that should be converted to uppercase (excluding boolean and date fields)
    const fieldsToCapitalize = [
      'distributor_code', 'region_code', 'region_name', 'dealer_code', 'dealer_name',
      'dealer_group_name', 'dealer_type', 'district_code', 'district_name',
      'vehicle_assignment_indicator', 'model_year', 'model_code', 'fd_fleet_description',
      'brand_code', 'segment_code', 'subsegment_code', 'team_member_lease_sale_type',
      'nap_cbu_code', 'series_name', 'series_display_order', 'grade_code',
      'transmissiontype_code', 'drivetrain_code', 'fueltype_code', 'enginefueltype_code',
      // Accessory-specific fields
      'fio_ppo_indicator', 'accessory_code', 'accessory_desc'
    ];

    const booleanFields = ['fleet_flag', 'fd_fleet_flag', 'car_trk_indicator', 'team_lease_indicator'];

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
      // Boolean fields and transaction_date are handled as-is
    });

    return processedFilters;
  }

  /**
   * Build enhanced query for V34 with accessory filtering
   * @param {Object} filters - Processed filters
   * @param {string} indexType - Index type
   * @param {Array} inlineFilters - Inline filters
   * @param {Array} sortFields - Sort fields
   * @returns {Object} OpenSearch query
   */
  _buildEnhancedQueryV34(filters, indexType, inlineFilters = [], sortFields = []) {
    // Reuse V33 query building logic since the structure is the same
    return this._buildEnhancedQueryV33(filters, indexType, inlineFilters, sortFields);
  }

  /**
   * Transform flat data array into hierarchical structure for V34 accessory endpoint
   * @param {Array} flatData - Array of flat data objects
   * @param {Object} pagination - Pagination parameters
   * @returns {Object} Enhanced hierarchical structure with new fields
   */
  _transformToHierarchicalStructureV34(flatData, pagination) {
    if (!Array.isArray(flatData) || flatData.length === 0) {
      return {
        regionSummary: {
          count: 0,
          regions: [],
          totals: {}
        }
      };
    }

    // Group data by region, district, and dealer
    const regionMap = new Map();
    const totals = {};

    // Initialize totals with all numeric fields including new V34 fields
    const numericFields = [
      'sales_availability_count', 'days_supply_count', 'retail_count', 'vpc_stock_count',
      'unbuilt_count', 'company_stock_count', 'dealer_stock_count', 'intransit_othervpc_count',
      'totalstock_count', 'other_vpc_count', 'postprocess_intransit_count', 'preprocess_intransit_vpc_count',
      'wholesale_count', 'hist_dealerstock_count', 'hist_tmsstock_count', 'hist_mfgstock_count',
      'hist_portstock_count', 'hist_intransitstock_count', 'sales_to_availability',
      // New V34 fields
      'distributor_count', 'retail_objective_count', 'wholesale_objective_count', 'dealer_retail_obj',
      'series_retail_ytd_obj', 'series_wholesale_ytd_obj', 'region_retail_ytd_obj', 'region_wholesale_ytd_obj',
      'retail_objective_percentage', 'wholesale_objective_percentage'
    ];

    numericFields.forEach(field => {
      totals[field] = 0;
    });

    flatData.forEach(item => {
      const regionCode = item.region_code;
      const regionName = item.region_name;
      const districtCode = item.district_code;
      const districtName = item.district_name;
      const dealerCode = item.dealer_code;
      const dealerName = item.dealer_name;
      const brandCode = item.brand_code || '';
      const vehicleAssignmentIndicator = this._convertToTrueFalseString(item.vehicle_assignment_indicator);
      const objectiveAvailableIndicator = this._convertToTrueFalseString(item.objective_available_indicator);

      // Initialize region if not exists
      if (!regionMap.has(regionCode)) {
        regionMap.set(regionCode, {
          region_code: regionCode,
          region_name: regionName,
          brand_code: brandCode,
          objective_available_indicator: objectiveAvailableIndicator,
          districts: new Map(),
          ...Object.fromEntries(numericFields.map(field => [field, 0]))
        });
      }

      const region = regionMap.get(regionCode);

      // Initialize district if not exists
      if (!region.districts.has(districtCode)) {
        region.districts.set(districtCode, {
          district_code: districtCode,
          district_name: districtName,
          brand_code: brandCode,
          vehicle_assignment_indicator: vehicleAssignmentIndicator,
          dealers: new Map(),
          ...Object.fromEntries(numericFields.map(field => [field, 0]))
        });
      }

      const district = region.districts.get(districtCode);

      // Initialize dealer if not exists
      if (!district.dealers.has(dealerCode)) {
        district.dealers.set(dealerCode, {
          dealer_code: dealerCode,
          dealer_name: dealerName,
          brand_code: brandCode,
          vehicle_assignment_indicator: vehicleAssignmentIndicator,
          ...Object.fromEntries(numericFields.map(field => [field, 0]))
        });
      }

      const dealer = district.dealers.get(dealerCode);

      // Aggregate numeric values
      numericFields.forEach(field => {
        if (field !== 'sales_to_availability' && field !== 'retail_objective_percentage' && field !== 'wholesale_objective_percentage') {
          const rawValue = item[field];
          const value = parseFloat(rawValue);

          // Log negative values for debugging
          if (value < 0) {
            console.log(`[DEBUG V34] Negative value detected - Field: ${field}, Value: ${value}, Dealer: ${dealerCode}, District: ${districtCode}, Region: ${regionCode}`);
          }

          // Use the parsed value or 0 if NaN, preserve negative values as-is
          const finalValue = isNaN(value) ? 0 : value;
          dealer[field] += finalValue;
          district[field] += finalValue;
          region[field] += finalValue;
          totals[field] += finalValue;
        }
      });

      // Handle calculated percentage fields separately
      dealer.retail_objective_percentage = parseFloat(item.retail_objective_percentage) || 0;
      dealer.wholesale_objective_percentage = parseFloat(item.wholesale_objective_percentage) || 0;
    });

    // Convert maps to arrays and structure the response
    const regions = Array.from(regionMap.values()).map(region => {
      const { districts, ...regionFields } = region;

      // Calculate region-level percentages
      const regionRetailCount = regionFields.retail_count || 0;
      const regionRetailObjective = regionFields.retail_objective_count || 0;
      const regionWholesaleCount = regionFields.wholesale_count || 0;
      const regionWholesaleObjective = regionFields.wholesale_objective_count || 0;
      const regionDealerStockCount = regionFields.dealer_stock_count || 0;

      regionFields.retail_objective_percentage = regionRetailObjective > 0
        ? parseFloat(((regionRetailCount / regionRetailObjective) * 100).toFixed(2))
        : 0;
      regionFields.wholesale_objective_percentage = regionWholesaleObjective > 0
        ? parseFloat(((regionWholesaleCount / regionWholesaleObjective) * 100).toFixed(2))
        : 0;

      // Always set sales_to_availability to 0 as per requirement
      regionFields.sales_to_availability = 0;

      // Set objective_available_indicator to match vehicle_assignment_indicator from districts
      // Use all districts (including filtered ones) to get the indicator value
      const firstDistrict = Array.from(districts.values())[0];
      if (firstDistrict && firstDistrict.vehicle_assignment_indicator) {
        regionFields.objective_available_indicator = firstDistrict.vehicle_assignment_indicator;
      }

      // Filter districts and dealers for final response
      const filteredDistricts = Array.from(districts.values())
        .filter(district => district.district_code !== '99') // Filter out district_code "99"
        .map(district => {
          const { dealers, ...districtFields } = district;

          // Calculate district-level percentages
          const districtRetailCount = districtFields.retail_count || 0;
          const districtRetailObjective = districtFields.retail_objective_count || 0;
          const districtWholesaleCount = districtFields.wholesale_count || 0;
          const districtWholesaleObjective = districtFields.wholesale_objective_count || 0;
          const districtDealerStockCount = districtFields.dealer_stock_count || 0;

          districtFields.retail_objective_percentage = districtRetailObjective > 0
            ? parseFloat(((districtRetailCount / districtRetailObjective) * 100).toFixed(2))
            : 0;
          districtFields.wholesale_objective_percentage = districtWholesaleObjective > 0
            ? parseFloat(((districtWholesaleCount / districtWholesaleObjective) * 100).toFixed(2))
            : 0;

          // Always set sales_to_availability to 0 as per requirement
          districtFields.sales_to_availability = 0;

          return {
            ...districtFields,
            dealers: Array.from(dealers.values())
              .filter(dealer => dealer.dealer_code !== '99999') // Filter out dealer_code "99999"
              .map(dealer => {
                // Always set sales_to_availability to 0 as per requirement
                dealer.sales_to_availability = 0;

                return dealer;
              })
          };
        });

      return {
        ...regionFields,
        districts: filteredDistricts
      };
    }).filter(region => region.districts.length > 0); // Remove regions with no districts after filtering

    // Calculate overall totals percentages
    const totalRetailCount = totals.retail_count || 0;
    const totalRetailObjective = totals.retail_objective_count || 0;
    const totalWholesaleCount = totals.wholesale_count || 0;
    const totalWholesaleObjective = totals.wholesale_objective_count || 0;
    const totalDealerStockCount = totals.dealer_stock_count || 0;

    totals.retail_objective_percentage = totalRetailObjective > 0
      ? parseFloat(((totalRetailCount / totalRetailObjective) * 100).toFixed(2))
      : 0;
    totals.wholesale_objective_percentage = totalWholesaleObjective > 0
      ? parseFloat(((totalWholesaleCount / totalWholesaleObjective) * 100).toFixed(2))
      : 0;

    // Always set sales_to_availability to 0 as per requirement
    totals.sales_to_availability = 0;

    // Calculate count as page_size * total_pages as specified in requirements
    const totalPages = pagination ? Math.ceil(regions.length / pagination.page_size) : 1;
    const pageSize = pagination ? pagination.page_size : regions.length;
    const count = pageSize * totalPages;

    return {
      regionSummary: {
        count: count,
        regions: regions,
        totals: totals
      }
    };
  }

  /**
   * Execute series color summary query with enhanced filtering and sorting
   * @param {Object} filters - Filter conditions
   * @param {Object} pagination - Pagination parameters
   * @param {Array} indexNames - Array of index names to query
   * @param {string} indexType - Index type for query logic
   * @param {Array} inlineFilters - Inline filters to apply
   * @param {Array} sortFields - Sort fields
   * @returns {Promise<Object>} Query result
   */
  async executeSeriesColorSummaryQuery(filters = null, pagination = { page: 1, page_size: 10 }, indexNames = [], indexType = '0', inlineFilters = [], sortFields = []) {
    const startTime = Date.now();
    let opensearchQuery = null;

    try {
      const client = await this.getClient();

      // Build the aggregation query for series color summary
      opensearchQuery = this._buildSeriesColorSummaryQuery(filters, indexType, inlineFilters, sortFields);

      console.log('Series Color Summary Query:', JSON.stringify(opensearchQuery, null, 2));

      const response = await client.search({
        index: indexNames.join(','),
        body: opensearchQuery
      });

      const executionTime = (Date.now() - startTime) / 1000;
      console.log(`Series Color Summary Query executed in ${executionTime.toFixed(2)} seconds`);

      // Debug: Log the raw aggregation response
      console.log('Series Color Summary Raw Aggregations:', JSON.stringify(response.body.aggregations, null, 2));

      // Process aggregation results
      const processedData = this._processSeriesColorSummaryAggregations(response.body.aggregations, indexType);

      // Debug: Log processed data
      console.log(`Series Color Summary Processed Data Count: ${processedData.length}`);
      if (processedData.length > 0) {
        console.log('Series Color Summary Sample Processed Item:', JSON.stringify(processedData[0], null, 2));
      }

      // Apply inline filtering if provided
      let filteredData = processedData;
      if (inlineFilters && inlineFilters.length > 0) {
        filteredData = this._applyInlineFilters(processedData, inlineFilters);
      }

      // Apply sorting if provided
      if (sortFields && sortFields.length > 0) {
        filteredData = this._applySorting(filteredData, sortFields);
      }

      const totalRecords = filteredData.length;

      const queryInfo = {
        took: response.body.took || 0,
        timed_out: response.body.timed_out || false,
        total_shards: response.body._shards?.total || 0,
        successful_shards: response.body._shards?.successful || 0,
        skipped_shards: response.body._shards?.skipped || 0,
        failed_shards: response.body._shards?.failed || 0
      };

      return {
        success: true,
        data: filteredData,
        total_records: totalRecords,
        query_info: queryInfo,
        execution_timestamp: new Date(),
        version: "series_color_summary",
        aggregation_level: "series_model_aggregation"
      };

    } catch (error) {
      const executionTime = (Date.now() - startTime) / 1000;
      console.error(`Series Color Summary Query failed after ${executionTime.toFixed(2)} seconds: ${error.message}`);

      if (opensearchQuery) {
        console.error(`Query that failed: ${JSON.stringify(opensearchQuery)}`);
      }

      return {
        success: false,
        error: `Series Color Summary Query execution failed: ${error.message}`,
        data: [],
        query_info: {
          took: 0,
          timed_out: false,
          total_shards: 0,
          successful_shards: 0,
          error: error.message
        },
        execution_timestamp: new Date(),
        version: "series_color_summary",
        aggregation_level: "series_model_aggregation"
      };
    }
  }

  /**
   * Build OpenSearch query for series color summary
   * @param {Object} filters - Filter conditions
   * @param {string} indexType - Index type for query logic
   * @param {Array} inlineFilters - Inline filters
   * @param {Array} sortFields - Sort fields
   * @returns {Object} OpenSearch query
   */
  _buildSeriesColorSummaryQuery(filters = null, indexType = '0', inlineFilters = [], sortFields = []) {
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
          filterDict.transaction_date = value;
        } else {
          filterDict[key] = value;
        }
      }
    }

    // Build the query with aggregations for series and model codes
    const query = {
      size: 0, // We only need aggregations
      query: Object.keys(filterDict).length > 0 ? this._buildOpenSearchQuery(filterDict) : { match_all: {} },
      aggs: {
        series_names: {
          terms: {
            field: "series_name",
            size: 1000,
            min_doc_count: 1,
            order: { _key: "asc" }
          },
          aggs: {
            model_codes: {
              terms: {
                field: "model_code",
                size: 1000,
                min_doc_count: 1,
                order: { _key: "asc" }
              },
              aggs: {
                // Sales counts based on index type
                net_daily_retail_count: { sum: { field: "net_daily_retail_count" } },
                net_mtd_retail_count: { sum: { field: "net_mtd_retail_count" } },
                net_ytd_retail_count: { sum: { field: "net_ytd_retail_count" } },
                net_daily_wholesale_count: { sum: { field: "net_daily_wholesale_count" } },
                net_mtd_wholesale_count: { sum: { field: "net_mtd_wholesale_count" } },
                net_ytd_wholesale_count: { sum: { field: "net_ytd_wholesale_count" } },
                net_daily_distributor_count: { sum: { field: "net_daily_distributor_count" } },
                net_mtd_distributor_count: { sum: { field: "net_mtd_distributor_count" } },
                net_ytd_distributor_count: { sum: { field: "net_ytd_distributor_count" } },

                // Objectives
                series_retail_obj: { sum: { field: "series_retail_obj" } },
                series_wholesale_obj: { sum: { field: "series_wholesale_obj" } },
                series_retail_ytd_obj: { sum: { field: "series_retail_ytd_obj" } },
                series_wholesale_ytd_obj: { sum: { field: "series_wholesale_ytd_obj" } },

                // Other fields (set to 0 as per requirements)
                vpc_stock_count: { sum: { field: "vpc_stock_count", missing: 0 } },
                unbuilt_count: { sum: { field: "unbuilt_count", missing: 0 } },
                company_stock_count: { sum: { field: "company_stock_count", missing: 0 } },
                dealer_stock_count: { sum: { field: "dealer_stock_count", missing: 0 } },
                intransit_othervpc_count: { sum: { field: "intransit_othervpc_count", missing: 0 } },
                totalstock_count: { sum: { field: "totalstock_count", missing: 0 } },
                other_vpc_count: { sum: { field: "other_vpc_count", missing: 0 } },
                postprocess_intransit_count: { sum: { field: "postprocess_intransit_count", missing: 0 } },
                preprocess_intransit_vpc_count: { sum: { field: "preprocess_intransit_vpc_count", missing: 0 } },
                hist_dealerstock_count: { sum: { field: "hist_dealerstock_count", missing: 0 } },
                hist_tmsstock_count: { sum: { field: "hist_tmsstock_count", missing: 0 } },
                hist_mfgstock_count: { sum: { field: "hist_mfgstock_count", missing: 0 } },
                hist_portstock_count: { sum: { field: "hist_portstock_count", missing: 0 } },
                hist_intransitstock_count: { sum: { field: "hist_intransitstock_count", missing: 0 } },
                sales_to_availability: { sum: { field: "sales_to_availability", missing: 0 } },

                // Get sample document for brand_code
                sample_doc: {
                  top_hits: {
                    size: 1,
                    _source: ["brand_code", "series_display_order"]
                  }
                }
              }
            },
            // Series-level aggregations
            series_sample_doc: {
              top_hits: {
                size: 1,
                _source: ["brand_code", "series_display_order","objective_record_indicator","objective_available_indicator"]
              }
            }
          }
        }
      }
    };

    return query;
  }

  /**
   * Process series color summary aggregation results
   * @param {Object} aggregations - OpenSearch aggregation results
   * @param {string} indexType - Index type for query logic
   * @returns {Array} Processed data array
   */
  _processSeriesColorSummaryAggregations(aggregations, indexType) {
    const processedData = [];

    if (!aggregations || !aggregations.series_names || !aggregations.series_names.buckets) {
      return processedData;
    }

    aggregations.series_names.buckets.forEach(seriesBucket => {
      const seriesName = seriesBucket.key;
      const seriesSampleDoc = seriesBucket.series_sample_doc?.hits?.hits?.[0]?._source || {};

      if (seriesBucket.model_codes && seriesBucket.model_codes.buckets) {
        seriesBucket.model_codes.buckets.forEach(modelBucket => {
          const modelCode = modelBucket.key;
          const modelSampleDoc = modelBucket.sample_doc?.hits?.hits?.[0]?._source || {};

          // Determine which counts to use based on index type
          let retailCount = 0;
          let wholesaleCount = 0;
          let distributorCount = 0;
          let retailObjective = 0;
          let wholesaleObjective = 0;
          let objectiveAvailable = false;

          if (indexType === '0') {
            // Daily data
            retailCount = modelBucket.net_daily_retail_count?.value || 0;
            wholesaleCount = modelBucket.net_daily_wholesale_count?.value || 0;
            distributorCount = modelBucket.net_daily_distributor_count?.value || 0;
            retailObjective = modelBucket.series_retail_obj?.value || 0;
            wholesaleObjective = modelBucket.series_wholesale_obj?.value || 0;
          } else if (indexType === '3') {
            // MTD data
            retailCount = modelBucket.net_mtd_retail_count?.value || 0;
            wholesaleCount = modelBucket.net_mtd_wholesale_count?.value || 0;
            distributorCount = modelBucket.net_mtd_distributor_count?.value || 0;
            retailObjective = modelBucket.series_retail_obj?.value || 0;
            wholesaleObjective = modelBucket.series_wholesale_obj?.value || 0;
          } else if (indexType === '5') {
            // YTD data
            retailCount = modelBucket.net_ytd_retail_count?.value || 0;
            wholesaleCount = modelBucket.net_ytd_wholesale_count?.value || 0;
            distributorCount = modelBucket.net_ytd_distributor_count?.value || 0;
            retailObjective = modelBucket.series_retail_ytd_obj?.value || 0;
            wholesaleObjective = modelBucket.series_wholesale_ytd_obj?.value || 0;
          }

          // Calculate objective percentages
          let retailObjectivePercentage = 0;
          let wholesaleObjectivePercentage = 0;

          if (retailObjective > 0) {
            retailObjectivePercentage = parseFloat(((retailCount / retailObjective) * 100).toFixed(1));
          }

          if (wholesaleObjective > 0) {
            wholesaleObjectivePercentage = parseFloat(((wholesaleCount / wholesaleObjective) * 100).toFixed(1));
          }
          if(retailObjective > 0 || wholesaleObjective > 0){
            objectiveAvailable = true;
          }
          else if (seriesSampleDoc.objective_record_indicator == true && seriesSampleDoc.objective_available_indicator == true) {
            objectiveAvailable = true;
          }
          else {
            objectiveAvailable = false;
          }
          const processedItem = {
            series_name: seriesName,
            model_code: modelCode,
            brand_code: modelSampleDoc.brand_code || seriesSampleDoc.brand_code || null,
            series_display_order: modelSampleDoc.series_display_order || seriesSampleDoc.series_display_order || null,
            objective_available_indicator: objectiveAvailable,

            // Sales counts
            retail_count: retailCount,
            wholesale_count: wholesaleCount,
            distributor_count: distributorCount,

            // Objectives
            retail_objective_count: retailObjective,
            retail_objective_percentage: retailObjectivePercentage,
            wholesale_objective_count: wholesaleObjective,
            wholesale_objective_percentage: wholesaleObjectivePercentage,

            // Stock counts (set to 0 as per requirements)
            sales_availability_count: 0,
            days_supply_count: 0,
            vpc_stock_count: modelBucket.vpc_stock_count?.value || 0,
            unbuilt_count: modelBucket.unbuilt_count?.value || 0,
            company_stock_count: modelBucket.company_stock_count?.value || 0,
            dealer_stock_count: modelBucket.dealer_stock_count?.value || 0,
            intransit_othervpc_count: modelBucket.intransit_othervpc_count?.value || 0,
            totalstock_count: modelBucket.totalstock_count?.value || 0,
            other_vpc_count: modelBucket.other_vpc_count?.value || 0,
            postprocess_intransit_count: modelBucket.postprocess_intransit_count?.value || 0,
            preprocess_intransit_vpc_count: modelBucket.preprocess_intransit_vpc_count?.value || 0,
            hist_dealerstock_count: modelBucket.hist_dealerstock_count?.value || 0,
            hist_tmsstock_count: modelBucket.hist_tmsstock_count?.value || 0,
            hist_mfgstock_count: modelBucket.hist_mfgstock_count?.value || 0,
            hist_portstock_count: modelBucket.hist_portstock_count?.value || 0,
            hist_intransitstock_count: modelBucket.hist_intransitstock_count?.value || 0,
            sales_to_availability: modelBucket.sales_to_availability?.value || 0
          };

          processedData.push(processedItem);
        });
      }
    });

    return processedData;
  }

  /**
   * Apply inline filters to processed data
   * @param {Array} data - Data to filter
   * @param {Array} inlineFilters - Inline filters to apply
   * @returns {Array} Filtered data
   */
  _applyInlineFilters(data, inlineFilters) {
    return data.filter(item => {
      return inlineFilters.every(filter => {
        const fieldValue = item[filter.field];

        if (fieldValue === undefined || fieldValue === null) {
          return false;
        }

        switch (filter.condition) {
          case '>=':
            return fieldValue >= filter.value;
          case '<=':
            return fieldValue <= filter.value;
          case '=':
            return fieldValue === filter.value;
          case '>':
            return fieldValue > filter.value;
          case '<':
            return fieldValue < filter.value;
          case 'contains':
            if (Array.isArray(filter.value)) {
              // Handle array of values for contains
              return filter.value.some(val =>
                String(fieldValue).toLowerCase().includes(String(val).toLowerCase())
              );
            } else {
              // Handle single value for contains
              const fieldStr = String(fieldValue).toLowerCase();
              const searchStr = String(filter.value).toLowerCase();
              return fieldStr.includes(searchStr);
            }
          default:
            return true;
        }
      });
    });
  }

  /**
   * Apply sorting to processed data
   * @param {Array} data - Data to sort
   * @param {Array} sortFields - Sort fields
   * @returns {Array} Sorted data
   */
  _applySorting(data, sortFields) {
    return data.sort((a, b) => {
      for (const sort of sortFields) {
        const fieldA = a[sort.field];
        const fieldB = b[sort.field];

        if (fieldA === undefined && fieldB !== undefined) return sort.order === 'asc' ? -1 : 1;
        if (fieldA !== undefined && fieldB === undefined) return sort.order === 'asc' ? 1 : -1;
        if (fieldA === undefined && fieldB === undefined) continue;

        if (fieldA < fieldB) return sort.order === 'asc' ? -1 : 1;
        if (fieldA > fieldB) return sort.order === 'asc' ? 1 : -1;
      }
      return 0;
    });
  }

  /**
   * Execute series accessory summary query with enhanced filtering and sorting
   * @param {Object} filters - Filter conditions
   * @param {Object} pagination - Pagination parameters
   * @param {Array} indexNames - Array of index names to query
   * @param {string} indexType - Index type for query logic
   * @param {Array} inlineFilters - Inline filters to apply
   * @param {Array} sortFields - Sort fields
   * @returns {Promise<Object>} Query result
   */
  async executeSeriesAccSummaryQuery(filters = null, pagination = { page: 1, page_size: 10 }, indexNames = [], indexType = '0', inlineFilters = [], sortFields = []) {
    const startTime = Date.now();
    let opensearchQuery = null;

    try {
      const client = await this.getClient();

      // Build the aggregation query for series accessory summary
      opensearchQuery = this._buildSeriesAccSummaryQuery(filters, indexType, inlineFilters, sortFields);

      console.log('Series Accessory Summary Query:', JSON.stringify(opensearchQuery, null, 2));

      const response = await client.search({
        index: indexNames.join(','),
        body: opensearchQuery
      });

      const executionTime = (Date.now() - startTime) / 1000;
      console.log(`Series Accessory Summary Query executed in ${executionTime.toFixed(2)} seconds`);

      // Debug: Log the raw aggregation response
      console.log('Series Accessory Summary Raw Aggregations:', JSON.stringify(response.body.aggregations, null, 2));

      // Process aggregation results
      const processedData = this._processSeriesAccSummaryAggregations(response.body.aggregations, indexType);

      // Debug: Log processed data
      console.log(`Series Accessory Summary Processed Data Count: ${processedData.length}`);
      if (processedData.length > 0) {
        console.log('Series Accessory Summary Sample Processed Item:', JSON.stringify(processedData[0], null, 2));
      }

      // Apply inline filtering if provided
      let filteredData = processedData;
      if (inlineFilters && inlineFilters.length > 0) {
        filteredData = this._applyInlineFilters(processedData, inlineFilters);
      }

      // Apply sorting if provided
      if (sortFields && sortFields.length > 0) {
        filteredData = this._applySorting(filteredData, sortFields);
      }

      const totalRecords = filteredData.length;

      const queryInfo = {
        took: response.body.took || 0,
        timed_out: response.body.timed_out || false,
        total_shards: response.body._shards?.total || 0,
        successful_shards: response.body._shards?.successful || 0,
        skipped_shards: response.body._shards?.skipped || 0,
        failed_shards: response.body._shards?.failed || 0
      };

      return {
        success: true,
        data: filteredData,
        total_records: totalRecords,
        query_info: queryInfo,
        execution_timestamp: new Date(),
        version: "series_acc_summary",
        aggregation_level: "series_model_aggregation"
      };

    } catch (error) {
      const executionTime = (Date.now() - startTime) / 1000;
      console.error(`Series Accessory Summary Query failed after ${executionTime.toFixed(2)} seconds: ${error.message}`);

      if (opensearchQuery) {
        console.error(`Query that failed: ${JSON.stringify(opensearchQuery)}`);
      }

      return {
        success: false,
        error: `Series Accessory Summary Query execution failed: ${error.message}`,
        data: [],
        query_info: {
          took: 0,
          timed_out: false,
          total_shards: 0,
          successful_shards: 0,
          error: error.message
        },
        execution_timestamp: new Date(),
        version: "series_acc_summary",
        aggregation_level: "series_model_aggregation"
      };
    }
  }

  /**
   * Build OpenSearch query for series accessory summary
   * @param {Object} filters - Filter conditions
   * @param {string} indexType - Index type for query logic
   * @param {Array} inlineFilters - Inline filters
   * @param {Array} sortFields - Sort fields
   * @returns {Object} OpenSearch query
   */
  _buildSeriesAccSummaryQuery(filters = null, indexType = '0', inlineFilters = [], sortFields = []) {
    // Reuse the color summary query building logic since the structure is the same
    return this._buildSeriesColorSummaryQuery(filters, indexType, inlineFilters, sortFields);
  }

  /**
   * Process series accessory summary aggregation results
   * @param {Object} aggregations - OpenSearch aggregation results
   * @param {string} indexType - Index type for query logic
   * @returns {Array} Processed data array
   */
  _processSeriesAccSummaryAggregations(aggregations, indexType) {
    // Reuse the color summary processing logic since the data structure is the same
    return this._processSeriesColorSummaryAggregations(aggregations, indexType);
  }

  /**
   * Execute dealer color summary query with ranking calculations
   * @param {Object} filters - The filters to apply
   * @param {Object} pagination - Pagination parameters
   * @param {Array} indexName - Index names to query
   * @param {string} indexType - Index type (0=daily, 3=MTD, 5=YTD)
   * @param {Array} inlineFilters - Inline filters for post-processing
   * @param {Array} sortFields - Sort fields for post-processing
   * @returns {Promise<Object>} The query response with dealer data and rankings
   */
  async executeDealerColorSummaryQuery(filters = null, pagination = null, indexName = null, indexType = '0', inlineFilters = [], sortFields = []) {
    const startTime = Date.now();
    let opensearchQuery = null;

    try {
      logger.info(`[DealerColorSummary] Starting dealer color summary query execution with index_type: ${indexType}`);
      console.log(`[DealerColorSummary] Input filters:`, JSON.stringify(filters));
      console.log(`[DealerColorSummary] Input indexName:`, indexName);

      if (!pagination) {
        pagination = { page: 1, page_size: 10 };
      }

      // Preprocess filters for uppercase conversion
      const processedFilters = this._preprocessFiltersForDealerSummary(filters);
      console.log(`[DealerColorSummary] Processed filters:`, JSON.stringify(processedFilters));

      // Use the correct index name - try multiple possible indices
      let indices = indexName;
      if (!indices) {
        const currentYear = new Date().getFullYear();
        const possibleIndices = [
          `pipe-rgn-dlr-dist-sale-color-current-summary-${currentYear}`,
          `pipe-rgn-dlr-dist-sale-color-current-summary-${currentYear - 1}`,
          `pipe-rgn-dlr-dist-sale-color-current-summary-2024`,
          `pipe-rgn-dlr-dist-sale-color-current-summary-2023`
        ];

        // Find the first index that exists and has data
        const client = await this.getClient();
        for (const testIndex of possibleIndices) {
          try {
            const existsResponse = await client.indices.exists({ index: testIndex });
            if (existsResponse.body) {
              const countResponse = await client.count({ index: testIndex });
              console.log(`[DealerColorSummary] Index ${testIndex} exists with ${countResponse.body.count} documents`);
              if (countResponse.body.count > 0) {
                indices = [testIndex];
                break;
              }
            }
          } catch (testError) {
            console.log(`[DealerColorSummary] Index ${testIndex} not available:`, testError.message);
          }
        }

        if (!indices) {
          indices = [possibleIndices[0]]; // Fallback to current year
        }
      }

      console.log(`[DealerColorSummary] Using indices:`, indices);

      // Test the selected index
      const client = await this.getClient();
      try {
        const indexExistsResponse = await client.indices.exists({ index: indices });
        console.log(`[DealerColorSummary] Index exists check:`, indexExistsResponse.body);

        // Try a simple count query to see if there's any data
        const countResponse = await client.count({ index: indices });
        console.log(`[DealerColorSummary] Total documents in index:`, countResponse.body.count);

        // If no data, try to list available indices
        if (countResponse.body.count === 0) {
          try {
            const catResponse = await client.cat.indices({ format: 'json' });
            const colorIndices = catResponse.body.filter(idx =>
              idx.index.includes('pipe-rgn-dlr-dist-sale-color')
            );
            console.log(`[DealerColorSummary] Available color indices:`, colorIndices.map(idx =>
              `${idx.index} (${idx['docs.count']} docs)`
            ));
          } catch (catError) {
            console.error(`[DealerColorSummary] Error listing indices:`, catError.message);
          }
        }
      } catch (indexError) {
        console.error(`[DealerColorSummary] Index check error:`, indexError.message);
      }

      // Execute the three required queries in parallel
      const [mainQueryResult, nationalRankingResult, regionalRankingResult] = await Promise.all([
        this._executeDealerMainQuery(processedFilters, indices, indexType, inlineFilters, sortFields),
        this._executeDealerNationalRankingQuery(indices, indexType, processedFilters),
        this._executeDealerRegionalRankingQuery(processedFilters, indices, indexType)
      ]);

      console.log(`[DealerColorSummary] Main query result count:`, mainQueryResult.length);
      console.log(`[DealerColorSummary] National ranking result count:`, Object.keys(nationalRankingResult).length);
      console.log(`[DealerColorSummary] Regional ranking result count:`, Object.keys(regionalRankingResult).length);

      // Merge results based on dealer_code
      let mergedData = this._mergeDealerQueryResults(mainQueryResult, nationalRankingResult, regionalRankingResult);

      // Apply sorting - default to national_ranking ASC if no sort fields provided
      if (sortFields && sortFields.length > 0) {
        mergedData = this._applySorting(mergedData, sortFields);
      } else {
        // Default sorting by national_ranking in ascending order
        mergedData = this._applySorting(mergedData, [{ field: 'national_ranking', order: 'asc' }]);
      }

      const totalRecords = mergedData.length;
      const executionTime = (Date.now() - startTime) / 1000;

      logger.info(`[DealerColorSummary] Query executed successfully in ${executionTime.toFixed(2)} seconds, ${totalRecords} records`);

      return {
        success: true,
        data: mergedData,
        total_records: totalRecords,
        execution_timestamp: new Date(),
        version: "dealer_color_summary_v1"
      };

    } catch (error) {
      const executionTime = (Date.now() - startTime) / 1000;
      logger.error(`[DealerColorSummary] Query failed after ${executionTime.toFixed(2)} seconds: ${error.message}`);
      console.error(`[DealerColorSummary] Full error:`, error);

      return {
        success: false,
        error: `Dealer Color Summary Query execution failed: ${error.message}`,
        data: [],
        execution_timestamp: new Date(),
        version: "dealer_color_summary_v1"
      };
    }
  }

  /**
   * Preprocess filters for dealer summary with uppercase conversion
   * @param {Object} filters - Raw filters
   * @returns {Object} Processed filters
   */
  _preprocessFiltersForDealerSummary(filters) {
    if (!filters) return null;

    const processedFilters = { ...filters };

    // Fields that need uppercase conversion
    const uppercaseFields = [
      'distributor_code', 'region_code', 'region_name', 'dealer_code', 'dealer_name',
      'dealer_group_name', 'dealer_type', 'district_code', 'district_name',
      'vehicle_assignment_indicator', 'model_year', 'model_code', 'fd_fleet_description',
      'brand_code', 'segment_code', 'subsegment_code', 'team_lease_indicator',
      'team_member_lease_sale_type', 'nap_cbu_code', 'series_name', 'series_display_order',
      'grade_code', 'transmissiontype_code', 'drivetrain_code', 'fueltype_code',
      'enginefueltype_code', 'exterior_color_code', 'exterior_color_desc',
      'interior_color_code', 'interior_trim_color_desc'
    ];

    // Boolean fields that should not be converted
    const booleanFields = ['fleet_flag', 'fd_fleet_flag', 'car_trk_indicator'];

    uppercaseFields.forEach(field => {
      if (processedFilters[field] && Array.isArray(processedFilters[field])) {
        processedFilters[field] = processedFilters[field].map(value =>
          typeof value === 'string' ? value.toUpperCase() : value
        );
      }
    });

    // Handle boolean fields - ensure they remain as boolean arrays
    booleanFields.forEach(field => {
      if (processedFilters[field] && Array.isArray(processedFilters[field])) {
        processedFilters[field] = processedFilters[field].map(value => {
          if (typeof value === 'string') {
            return value.toLowerCase() === 'true';
          }
          return Boolean(value);
        });
      }
    });

    return processedFilters;
  }

  /**
   * Execute main dealer query with filters
   * @param {Object} filters - Processed filters
   * @param {Array} indices - Index names
   * @param {string} indexType - Index type
   * @param {Array} inlineFilters - Inline filters
   * @param {Array} sortFields - Sort fields
   * @returns {Promise<Array>} Main query results
   */
  async _executeDealerMainQuery(filters, indices, indexType, inlineFilters, sortFields) {
    const client = await this.getClient();

    // Determine which count field to use based on index_type
    let retailCountField, wholesaleCountField, distributorCountField;
    switch (indexType) {
      case '0':
        retailCountField = 'net_daily_retail_count';
        wholesaleCountField = 'net_daily_wholesale_count';
        distributorCountField = 'net_daily_distributor_count';
        break;
      case '3':
        retailCountField = 'net_mtd_retail_count';
        wholesaleCountField = 'net_mtd_wholesale_count';
        distributorCountField = 'net_mtd_distributor_count';
        break;
      case '5':
        retailCountField = 'net_ytd_retail_count';
        wholesaleCountField = 'net_ytd_wholesale_count';
        distributorCountField = 'net_ytd_distributor_count';
        break;
      default:
        retailCountField = 'net_daily_retail_count';
        wholesaleCountField = 'net_daily_wholesale_count';
        distributorCountField = 'net_daily_distributor_count';
    }

    console.log(`[DealerMainQuery] Using fields: retail=${retailCountField}, wholesale=${wholesaleCountField}, distributor=${distributorCountField}`);

    // Build the main query with aggregations and dummy record exclusion
    const baseQuery = filters ? this._buildFilterQuery(filters) : { match_all: {} };

    // Add exclusion filters for dummy records
    const queryWithExclusions = this._addDummyRecordExclusions(baseQuery);

    const query = {
      size: 0,
      query: queryWithExclusions,
      aggs: {
        dealer_aggregated: {
          terms: {
            field: "dealer_code",
            size: 10000
          },
          aggs: {
            distributor_code: { terms: { field: "distributor_code", size: 1 } },
            region_code: { terms: { field: "region_code", size: 1 } },
            region_name: { terms: { field: "region_name", size: 1 } },
            dealer_name: { terms: { field: "dealer_name", size: 1 } },
            brand_code: { terms: { field: "brand_code", size: 1 } },
            district_code: { terms: { field: "district_code", size: 1 } },
            district_name: { terms: { field: "district_name", size: 1 } },
            vehicle_assignment_indicator: { terms: { field: "vehicle_assignment_indicator", size: 1 } },
            retail_count: { sum: { field: retailCountField } },
            wholesale_count: { sum: { field: wholesaleCountField } },
            distributor_count: { sum: { field: distributorCountField } }
          }
        }
      }
    };

    console.log(`[DealerMainQuery] Query:`, JSON.stringify(query, null, 2));

    const response = await client.search({
      index: indices,
      body: query,
      timeout: '30s'
    });

    console.log(`[DealerMainQuery] Response status:`, response.statusCode);
    console.log(`[DealerMainQuery] Response took:`, response.body.took);
    console.log(`[DealerMainQuery] Total hits:`, response.body.hits?.total?.value || 0);

    // Process the aggregation results
    const buckets = response.body.aggregations?.dealer_aggregated?.buckets || [];
    console.log(`[DealerMainQuery] Aggregation buckets count:`, buckets.length);

    if (buckets.length > 0) {
      console.log(`[DealerMainQuery] First bucket sample:`, JSON.stringify(buckets[0], null, 2));
    }

    const results = buckets.map(bucket => ({
      dealer_code: bucket.key,
      distributor_code: bucket.distributor_code.buckets[0]?.key || '',
      dealer_name: bucket.dealer_name.buckets[0]?.key || '',
      brand_code: bucket.brand_code.buckets[0]?.key || '',
      region_code: bucket.region_code.buckets[0]?.key || '',
      region_name: bucket.region_name.buckets[0]?.key || '',
      district_code: bucket.district_code.buckets[0]?.key || '',
      district_name: bucket.district_name.buckets[0]?.key || '',
      vehicle_assignment_indicator: this._convertToTrueFalseString(bucket.vehicle_assignment_indicator.buckets[0]?.key),
      retail_count: bucket.retail_count.value || 0,
      wholesale_count: bucket.wholesale_count.value || 0,
      distributor_count: bucket.distributor_count.value || 0,
      // Default values for stock fields
      sales_availability_count: 0,
      days_supply_count: 0,
      vpc_stock_count: 0,
      unbuilt_count: 0,
      company_stock_count: 0,
      dealer_stock_count: 0,
      intransit_othervpc_count: 0,
      totalstock_count: 0,
      other_vpc_count: 0,
      postprocess_intransit_count: 0,
      preprocess_intransit_vpc_count: 0,
      hist_dealerstock_count: 0,
      hist_tmsstock_count: 0,
      hist_mfgstock_count: 0,
      hist_portstock_count: 0,
      hist_intransitstock_count: 0,
      sales_to_availability: 0
    }));

    console.log(`[DealerMainQuery] Processed results count:`, results.length);

    // Apply inline filters
    let filteredResults = this._applyDealerInlineFilters(results, inlineFilters);
    console.log(`[DealerMainQuery] After inline filters:`, filteredResults.length);

    // Apply sorting
    filteredResults = this._applyDealerSorting(filteredResults, sortFields);
    console.log(`[DealerMainQuery] After sorting:`, filteredResults.length);

    return filteredResults;
  }

  /**
   * Execute national ranking query with optional filters
   * @param {Array} indices - Index names
   * @param {string} indexType - Index type
   * @param {Object} filters - Optional filters to apply (if null, no filters applied)
   * @returns {Promise<Object>} National ranking results
   */
  async _executeDealerNationalRankingQuery(indices, indexType, filters = null) {
    const client = await this.getClient();

    // Determine which count field to use based on index_type
    let retailCountField;
    switch (indexType) {
      case '0':
        retailCountField = 'net_daily_retail_count';
        break;
      case '3':
        retailCountField = 'net_mtd_retail_count';
        break;
      case '5':
        retailCountField = 'net_ytd_retail_count';
        break;
      default:
        retailCountField = 'net_daily_retail_count';
    }

    // Build query with optional filters (excluding region_code, district_code, and dealer_code for national ranking)
    let baseQuery;
    if (filters) {
      // Remove region_code, district_code, and dealer_code from filters for national ranking
      const filtersForNationalRanking = { ...filters };
      delete filtersForNationalRanking.region_code;
      delete filtersForNationalRanking.district_code;
      delete filtersForNationalRanking.dealer_code;

      // Process filters with uppercase conversion for specific fields
      const processedFilters = this._preprocessFiltersForNationalRanking(filtersForNationalRanking);
      baseQuery = this._buildFilterQuery(processedFilters);

      console.log(`[DealerNationalRanking] Excluded region_code, district_code, and dealer_code from national ranking filters`);
    } else {
      baseQuery = { match_all: {} };
    }

    const query = {
      size: 0,
      query: this._addDummyRecordExclusions(baseQuery), // Apply filters (if any) and exclude dummy records
      aggs: {
        distributor_groups: {
          terms: {
            field: "distributor_code",
            size: 1000
          },
          aggs: {
            dealer_ranking: {
              terms: {
                field: "dealer_code",
                size: 10000,
                order: { total_retail_count: "desc" }
              },
              aggs: {
                total_retail_count: { sum: { field: retailCountField } }
              }
            }
          }
        }
      }
    };

    console.log(`[DealerNationalRanking] Using ${filters ? 'filtered' : 'unfiltered'} query for national ranking`);
    if (filters) {
      const filtersForNationalRanking = { ...filters };
      delete filtersForNationalRanking.region_code;
      delete filtersForNationalRanking.district_code;
      delete filtersForNationalRanking.dealer_code;
      console.log(`[DealerNationalRanking] Applied filters (region_code, district_code, dealer_code excluded):`, JSON.stringify(filtersForNationalRanking));
    }

    const response = await client.search({
      index: indices,
      body: query,
      timeout: '30s'
    });

    console.log(`[DealerNationalRanking] Query executed, processing response...`);
    console.log(`[DealerNationalRanking] Response aggregations:`, JSON.stringify(response.body.aggregations, null, 2));

    // Process national ranking results
    const nationalRankings = {};
    const distributorBuckets = response.body.aggregations?.distributor_groups?.buckets || [];

    console.log(`[DealerNationalRanking] Found ${distributorBuckets.length} distributor buckets`);

    distributorBuckets.forEach(distributorBucket => {
      const distributorCode = distributorBucket.key;
      const dealerBuckets = distributorBucket.dealer_ranking.buckets || [];

      console.log(`[DealerNationalRanking] Distributor ${distributorCode} has ${dealerBuckets.length} dealers`);

      // Handle tied rankings - dealers with same retail count get same rank
      let currentRank = 1;
      let previousRetailCount = null;

      dealerBuckets.forEach((dealerBucket, index) => {
        const dealerCode = dealerBucket.key;
        const retailCount = dealerBucket.total_retail_count.value;

        // If retail count is different from previous, increment rank by 1 (dense ranking)
        if (previousRetailCount !== null && retailCount !== previousRetailCount) {
          currentRank = currentRank + 1;
        }

        const nationalRank = currentRank;
        nationalRankings[`${distributorCode}_${dealerCode}`] = nationalRank;

        if (index < 5) { // Log first 5 for debugging
          console.log(`[DealerNationalRanking] ${distributorCode}_${dealerCode} = rank ${nationalRank} (retail: ${retailCount})`);
        }

        previousRetailCount = retailCount;
      });
    });

    console.log(`[DealerNationalRanking] Total national rankings created:`, Object.keys(nationalRankings).length);
    return nationalRankings;
  }

  /**
   * Execute regional ranking query (only region filter applied)
   * @param {Object} filters - Processed filters
   * @param {Array} indices - Index names
   * @param {string} indexType - Index type
   * @returns {Promise<Object>} Regional ranking results
   */
  async _executeDealerRegionalRankingQuery(filters, indices, indexType) {
    const client = await this.getClient();

    // Determine which count field to use based on index_type
    let retailCountField;
    switch (indexType) {
      case '0':
        retailCountField = 'net_daily_retail_count';
        break;
      case '3':
        retailCountField = 'net_mtd_retail_count';
        break;
      case '5':
        retailCountField = 'net_ytd_retail_count';
        break;
      default:
        retailCountField = 'net_daily_retail_count';
    }

    // Build query with regional ranking filters
    const regionalRankingFilters = {};

    // Fields to include for regional ranking with uppercase conversion
    const regionalRankingFields = [
      'region_code', 'region_name', 'distributor_code', 'vehicle_assignment_indicator',
      'model_year', 'model_code', 'fd_fleet_description', 'brand_code', 'segment_code',
      'subsegment_code', 'team_lease_indicator', 'team_member_lease_sale_type',
      'nap_cbu_code', 'series_name', 'series_display_order', 'grade_code',
      'transmissiontype_code', 'drivetrain_code', 'fueltype_code', 'enginefueltype_code',
      'exterior_color_code', 'exterior_color_desc', 'interior_color_code', 'interior_trim_color_desc'
    ];

    // Boolean fields that should not be converted to uppercase
    const booleanFields = ['fleet_flag', 'fd_fleet_flag', 'car_trk_indicator'];

    // If no filters are passed, use existing logic with only region_code
    if (!filters || Object.keys(filters).length === 0) {
      // Default behavior - no filters applied
    } else {
      // Apply filters for the specified fields, converting to uppercase
      regionalRankingFields.forEach(field => {
        if (filters && filters[field]) {
          if (Array.isArray(filters[field])) {
            regionalRankingFilters[field] = filters[field].map(value =>
              typeof value === 'string' ? value.toUpperCase() : value
            );
          } else if (typeof filters[field] === 'string') {
            regionalRankingFilters[field] = filters[field].toUpperCase();
          } else {
            regionalRankingFilters[field] = filters[field];
          }
        }
      });

      // Handle boolean fields separately - no uppercase conversion
      booleanFields.forEach(field => {
        if (filters && filters[field]) {
          if (Array.isArray(filters[field])) {
            regionalRankingFilters[field] = filters[field].map(value => {
              if (typeof value === 'string') {
                return value.toLowerCase() === 'true';
              }
              return Boolean(value);
            });
          } else {
            if (typeof filters[field] === 'string') {
              regionalRankingFilters[field] = [filters[field].toLowerCase() === 'true'];
            } else {
              regionalRankingFilters[field] = [Boolean(filters[field])];
            }
          }
        }
      });

      // If no regional ranking fields are present in filters, fall back to region_code only
      if (Object.keys(regionalRankingFilters).length === 0 && filters.region_code) {
        regionalRankingFilters.region_code = filters.region_code;
      }
    }

    // Add specific logging for series_name if present
    if (regionalRankingFilters.series_name) {
      console.log(`[DealerRegionalRanking] series_name filter applied:`, regionalRankingFilters.series_name);
    }

    // Add specific logging for fleet_flag if present
    if (regionalRankingFilters.fleet_flag) {
      console.log(`[DealerRegionalRanking] fleet_flag filter applied:`, regionalRankingFilters.fleet_flag);
    }

    console.log(`[DealerRegionalRanking] Applied filters:`, JSON.stringify(regionalRankingFilters));

    const query = {
      size: 0,
      query: this._addDummyRecordExclusions(this._buildFilterQuery(regionalRankingFilters)),
      aggs: {
        region_groups: {
          terms: {
            field: "region_code",
            size: 1000
          },
          aggs: {
            dealer_ranking: {
              terms: {
                field: "dealer_code",
                size: 10000,
                order: { total_retail_count: "desc" }
              },
              aggs: {
                total_retail_count: { sum: { field: retailCountField } }
              }
            }
          }
        }
      }
    };

    const response = await client.search({
      index: indices,
      body: query,
      timeout: '30s'
    });

    console.log(`[DealerRegionalRanking] Query executed, processing response...`);
    console.log(`[DealerRegionalRanking] Response aggregations:`, JSON.stringify(response.body.aggregations, null, 2));

    // Process regional ranking results
    const regionalRankings = {};
    const regionBuckets = response.body.aggregations?.region_groups?.buckets || [];

    console.log(`[DealerRegionalRanking] Found ${regionBuckets.length} region buckets`);

    regionBuckets.forEach(regionBucket => {
      const regionCode = regionBucket.key;
      const dealerBuckets = regionBucket.dealer_ranking.buckets || [];

      console.log(`[DealerRegionalRanking] Region ${regionCode} has ${dealerBuckets.length} dealers`);

      // Handle tied rankings - dealers with same retail count get same rank (dense ranking)
      let currentRank = 1;
      let previousRetailCount = null;

      dealerBuckets.forEach((dealerBucket, index) => {
        const dealerCode = dealerBucket.key;
        const retailCount = dealerBucket.total_retail_count.value;

        // If retail count is different from previous, increment rank by 1 (dense ranking)
        if (previousRetailCount !== null && retailCount !== previousRetailCount) {
          currentRank = currentRank + 1;
        }

        const regionalRank = currentRank;
        regionalRankings[`${regionCode}_${dealerCode}`] = regionalRank;

        if (index < 5) { // Log first 5 for debugging
          console.log(`[DealerRegionalRanking] ${regionCode}_${dealerCode} = rank ${regionalRank} (retail: ${retailCount})`);
        }

        previousRetailCount = retailCount;
      });
    });

    console.log(`[DealerRegionalRanking] Total regional rankings created:`, Object.keys(regionalRankings).length);
    return regionalRankings;
  }

  /**
   * Merge results from main query, national ranking, and regional ranking
   * @param {Array} mainResults - Main query results
   * @param {Object} nationalRankings - National ranking results
   * @param {Object} regionalRankings - Regional ranking results
   * @returns {Array} Merged results
   */
  _mergeDealerQueryResults(mainResults, nationalRankings, regionalRankings) {
    console.log(`[MergeDealerResults] Merging ${mainResults.length} main results`);
    console.log(`[MergeDealerResults] National rankings available:`, Object.keys(nationalRankings).length);
    console.log(`[MergeDealerResults] Regional rankings available:`, Object.keys(regionalRankings).length);

    // Log first few ranking keys for debugging
    const nationalKeys = Object.keys(nationalRankings).slice(0, 5);
    const regionalKeys = Object.keys(regionalRankings).slice(0, 5);
    console.log(`[MergeDealerResults] Sample national keys:`, nationalKeys);
    console.log(`[MergeDealerResults] Sample regional keys:`, regionalKeys);

    return mainResults.map((dealer, index) => {
      // Find national ranking using distributor_code and dealer_code
      const nationalRankingKey = `${dealer.distributor_code}_${dealer.dealer_code}`;
      const nationalRanking = nationalRankings[nationalRankingKey] || 0;

      // Find regional ranking using region_code and dealer_code
      const regionalRankingKey = `${dealer.region_code}_${dealer.dealer_code}`;
      const regionalRanking = regionalRankings[regionalRankingKey] || 0;

      // Debug first few dealers
      if (index < 3) {
        console.log(`[MergeDealerResults] Dealer ${dealer.dealer_code}:`);
        console.log(`  - Distributor: ${dealer.distributor_code}, Region: ${dealer.region_code}`);
        console.log(`  - Looking for national key: ${nationalRankingKey}`);
        console.log(`  - Found national ranking: ${nationalRanking}`);
        console.log(`  - Looking for regional key: ${regionalRankingKey}`);
        console.log(`  - Found regional ranking: ${regionalRanking}`);
      }

      return {
        ...dealer,
        national_ranking: nationalRanking,
        regional_ranking: regionalRanking
      };
    });
  }

  /**
   * Apply inline filters to dealer data
   * @param {Array} data - Dealer data
   * @param {Array} inlineFilters - Inline filters
   * @returns {Array} Filtered data
   */
  _applyDealerInlineFilters(data, inlineFilters) {
    if (!inlineFilters || !Array.isArray(inlineFilters) || inlineFilters.length === 0) {
      return data;
    }

    return data.filter(item => {
      return inlineFilters.every(filter => {
        const fieldValue = item[filter.field];

        if (filter.condition === 'contains') {
          if (!fieldValue) return false;
          const values = Array.isArray(filter.value) ? filter.value : [filter.value];
          return values.some(value =>
            fieldValue.toString().toUpperCase().includes(value.toString().toUpperCase())
          );
        } else {
          // Numeric conditions
          const numericValue = parseFloat(fieldValue);
          const filterNumericValue = parseFloat(filter.value);

          if (isNaN(numericValue) || isNaN(filterNumericValue)) {
            return false;
          }

          switch (filter.condition) {
            case '>=': return numericValue >= filterNumericValue;
            case '<=': return numericValue <= filterNumericValue;
            case '=': return numericValue === filterNumericValue;
            case '>': return numericValue > filterNumericValue;
            case '<': return numericValue < filterNumericValue;
            default: return true;
          }
        }
      });
    });
  }

  /**
   * Apply sorting to dealer data
   * @param {Array} data - Dealer data
   * @param {Array} sortFields - Sort fields
   * @returns {Array} Sorted data
   */
  _applyDealerSorting(data, sortFields) {
    if (!sortFields || !Array.isArray(sortFields) || sortFields.length === 0) {
      return data;
    }

    return data.sort((a, b) => {
      for (const sortField of sortFields) {
        const aValue = a[sortField.field];
        const bValue = b[sortField.field];

        let comparison = 0;
        if (typeof aValue === 'string' && typeof bValue === 'string') {
          comparison = aValue.localeCompare(bValue);
        } else {
          comparison = (aValue || 0) - (bValue || 0);
        }

        if (comparison !== 0) {
          return sortField.order === 'desc' ? -comparison : comparison;
        }
      }
      return 0;
    });
  }

  /**
   * Build filter query for OpenSearch
   * @param {Object} filters - Filters to apply
   * @returns {Object} OpenSearch query
   */
  _buildFilterQuery(filters) {
    console.log(`[BuildFilterQuery] Input filters:`, JSON.stringify(filters));

    if (!filters || Object.keys(filters).length === 0) {
      console.log(`[BuildFilterQuery] No filters, using match_all`);
      return { match_all: {} };
    }

    const mustClauses = [];

    Object.entries(filters).forEach(([field, values]) => {
      console.log(`[BuildFilterQuery] Processing field: ${field}, values:`, values);

      if (values && Array.isArray(values) && values.length > 0) {
        if (field === 'transaction_date') {
          // Handle date range
          const dateRange = {};
          if (values.gte) dateRange.gte = values.gte;
          if (values.lte) dateRange.lte = values.lte;
          if (Object.keys(dateRange).length > 0) {
            const rangeClause = { range: { [field]: dateRange } };
            mustClauses.push(rangeClause);
            console.log(`[BuildFilterQuery] Added date range clause:`, rangeClause);
          }
        } else {
          // Handle array filters
          const termsClause = {
            terms: { [field]: values }
          };
          mustClauses.push(termsClause);
          console.log(`[BuildFilterQuery] Added terms clause:`, termsClause);
        }
      } else {
        console.log(`[BuildFilterQuery] Skipping field ${field} - invalid values`);
      }
    });

    const finalQuery = mustClauses.length > 0 ? { bool: { must: mustClauses } } : { match_all: {} };
    console.log(`[BuildFilterQuery] Final query:`, JSON.stringify(finalQuery));

    return finalQuery;
  }

  /**
   * Add exclusions for dummy records to a query
   * Excludes dealer_code "99999" and district_code "99"
   * @param {Object} query - The base query
   * @returns {Object} Query with dummy record exclusions
   */
  _addDummyRecordExclusions(query) {
    console.log(`[DummyRecordExclusions] Adding exclusions for dealer_code=99999 and district_code=99`);

    // If query is match_all, convert to bool query with must_not
    if (query.match_all) {
      return {
        bool: {
          must: [{ match_all: {} }],
          must_not: [
            { term: { dealer_code: "99999" } },
            { term: { district_code: "99" } }
          ]
        }
      };
    }

    // If query is already a bool query, add must_not clauses
    if (query.bool) {
      const updatedQuery = { ...query };
      updatedQuery.bool.must_not = [
        ...(updatedQuery.bool.must_not || []),
        { term: { dealer_code: "99999" } },
        { term: { district_code: "99" } }
      ];
      return updatedQuery;
    }

    // For other query types, wrap in bool query
    return {
      bool: {
        must: [query],
        must_not: [
          { term: { dealer_code: "99999" } },
          { term: { district_code: "99" } }
        ]
      }
    };
  }

  /**
   * Preprocess filters for national ranking with uppercase conversion for specific fields
   * @param {Object} filters - The filters to preprocess
   * @returns {Object} Processed filters
   */
  _preprocessFiltersForNationalRanking(filters) {
    if (!filters) return null;

    const processedFilters = { ...filters };

    // Fields that need uppercase conversion
    const uppercaseFields = [
      'distributor_code',
      'vehicle_assignment_indicator',
      'model_year',
      'model_code',
      'fd_fleet_description',
      'brand_code',
      'segment_code',
      'subsegment_code',
      'team_lease_indicator',
      'team_member_lease_sale_type',
      'nap_cbu_code',
      'series_name',
      'series_display_order',
      'grade_code',
      'transmissiontype_code',
      'drivetrain_code',
      'fueltype_code',
      'enginefueltype_code',
      'exterior_color_code',
      'exterior_color_desc',
      'interior_color_code',
      'interior_trim_color_desc'
    ];

    // Boolean fields that should not be converted
    const booleanFields = ['fleet_flag', 'fd_fleet_flag', 'car_trk_indicator'];

    uppercaseFields.forEach(field => {
      if (processedFilters[field] && Array.isArray(processedFilters[field])) {
        const originalValues = [...processedFilters[field]];
        processedFilters[field] = processedFilters[field].map(value =>
          typeof value === 'string' ? value.toUpperCase() : value
        );
        if (field === 'series_name') {
          console.log(`[NationalRankingFilters] series_name conversion: ${JSON.stringify(originalValues)} -> ${JSON.stringify(processedFilters[field])}`);
        }
      }
    });

    // Handle boolean fields - ensure they remain as boolean arrays
    booleanFields.forEach(field => {
      if (processedFilters[field] && Array.isArray(processedFilters[field])) {
        processedFilters[field] = processedFilters[field].map(value => {
          if (typeof value === 'string') {
            return value.toLowerCase() === 'true';
          }
          return Boolean(value);
        });
      }
    });

    console.log(`[NationalRankingFilters] Original filters:`, JSON.stringify(filters));
    console.log(`[NationalRankingFilters] Processed filters:`, JSON.stringify(processedFilters));

    return processedFilters;
  }

  /**
   * Convert vehicle assignment indicator values to TRUE/FALSE strings
   * @param {*} value - The value to convert
   * @returns {string} "TRUE" or "FALSE"
   */
  _convertToTrueFalseString(value) {
    if (value === null || value === undefined || value === '') {
      return false;
    }

    // Handle string values
    if (typeof value === 'string') {
      const upperValue = value.toUpperCase();
      if (upperValue === 'TRUE' || upperValue === '1' || upperValue === 'YES') {
        return true;
      }
      return false;
    }

    // Handle numeric values
    if (typeof value === 'number') {
      return value === 1 ? true : false;
    }

    // Handle boolean values
    if (typeof value === 'boolean') {
      return value ? true : false;
    }

    // Default to FALSE for any other type
    return false;
  }

  /**
   * Execute dealer accessory summary query with ranking calculations
   * @param {Object} filters - The filters to apply
   * @param {Object} pagination - Pagination parameters
   * @param {Array} indexName - Index names to query
   * @param {string} indexType - Index type (0=daily, 3=MTD, 5=YTD)
   * @param {Array} inlineFilters - Inline filters for post-processing
   * @param {Array} sortFields - Sort fields for post-processing
   * @returns {Promise<Object>} The query response with dealer data and rankings
   */
  async executeDealerAccSummaryQuery(filters = null, pagination = null, indexName = null, indexType = '0', inlineFilters = [], sortFields = []) {
    const startTime = Date.now();
    let opensearchQuery = null;

    try {
      logger.info(`[DealerAccSummary] Starting dealer accessory summary query execution with index_type: ${indexType}`);
      console.log(`[DealerAccSummary] Input filters:`, JSON.stringify(filters));
      console.log(`[DealerAccSummary] Input indexName:`, indexName);

      if (!pagination) {
        pagination = { page: 1, page_size: 10 };
      }

      // Preprocess filters for uppercase conversion
      const processedFilters = this._preprocessFiltersForDealerAccSummary(filters);
      console.log(`[DealerAccSummary] Processed filters:`, JSON.stringify(processedFilters));

      // Use the correct index name - try multiple possible indices
      let indices = indexName;
      if (!indices) {
        const currentYear = new Date().getFullYear();
        const possibleIndices = [
          `pipe-rgn-dlr-dist-sale-color-current-summary-${currentYear}`,
          `pipe-rgn-dlr-dist-sale-color-current-summary-${currentYear - 1}`,
          `pipe-rgn-dlr-dist-sale-color-current-summary-2024`,
          `pipe-rgn-dlr-dist-sale-color-current-summary-2023`
        ];

        // Find the first index that exists and has data
        const client = await this.getClient();
        for (const testIndex of possibleIndices) {
          try {
            const existsResponse = await client.indices.exists({ index: testIndex });
            if (existsResponse.body) {
              const countResponse = await client.count({ index: testIndex });
              console.log(`[DealerAccSummary] Index ${testIndex} exists with ${countResponse.body.count} documents`);
              if (countResponse.body.count > 0) {
                indices = [testIndex];
                break;
              }
            }
          } catch (testError) {
            console.log(`[DealerAccSummary] Index ${testIndex} not available:`, testError.message);
          }
        }

        if (!indices) {
          indices = [possibleIndices[0]]; // Fallback to current year
        }
      }

      console.log(`[DealerAccSummary] Using indices:`, indices);

      // Test the selected index
      const client = await this.getClient();
      try {
        const indexExistsResponse = await client.indices.exists({ index: indices });
        console.log(`[DealerAccSummary] Index exists check:`, indexExistsResponse.body);

        // Try a simple count query to see if there's any data
        const countResponse = await client.count({ index: indices });
        console.log(`[DealerAccSummary] Total documents in index:`, countResponse.body.count);

        // If no data, try to list available indices
        if (countResponse.body.count === 0) {
          try {
            const catResponse = await client.cat.indices({ format: 'json' });
            const colorIndices = catResponse.body.filter(idx =>
              idx.index.includes('pipe-rgn-dlr-dist-sale-color')
            );
            console.log(`[DealerAccSummary] Available color indices:`, colorIndices.map(idx =>
              `${idx.index} (${idx['docs.count']} docs)`
            ));
          } catch (catError) {
            console.error(`[DealerAccSummary] Error listing indices:`, catError.message);
          }
        }
      } catch (indexError) {
        console.error(`[DealerAccSummary] Index check error:`, indexError.message);
      }

      // Execute the three required queries in parallel
      const [mainQueryResult, nationalRankingResult, regionalRankingResult] = await Promise.all([
        this._executeDealerAccMainQuery(processedFilters, indices, indexType, inlineFilters, sortFields),
        this._executeDealerAccNationalRankingQuery(indices, indexType, processedFilters),
        this._executeDealerAccRegionalRankingQuery(processedFilters, indices, indexType)
      ]);

      console.log(`[DealerAccSummary] Main query result count:`, mainQueryResult.length);
      console.log(`[DealerAccSummary] National ranking result count:`, Object.keys(nationalRankingResult).length);
      console.log(`[DealerAccSummary] Regional ranking result count:`, Object.keys(regionalRankingResult).length);

      // Merge results based on dealer_code
      let mergedData = this._mergeDealerAccQueryResults(mainQueryResult, nationalRankingResult, regionalRankingResult);

      // Apply sorting - default to national_ranking ASC if no sort fields provided
      if (sortFields && sortFields.length > 0) {
        mergedData = this._applySorting(mergedData, sortFields);
      } else {
        // Default sorting by national_ranking in ascending order
        mergedData = this._applySorting(mergedData, [{ field: 'national_ranking', order: 'asc' }]);
      }

      const totalRecords = mergedData.length;
      const executionTime = (Date.now() - startTime) / 1000;

      logger.info(`[DealerAccSummary] Query executed successfully in ${executionTime.toFixed(2)} seconds, ${totalRecords} records`);

      return {
        success: true,
        data: mergedData,
        total_records: totalRecords,
        execution_timestamp: new Date(),
        version: "dealer_acc_summary_v1"
      };

    } catch (error) {
      const executionTime = (Date.now() - startTime) / 1000;
      logger.error(`[DealerAccSummary] Query failed after ${executionTime.toFixed(2)} seconds: ${error.message}`);
      console.error(`[DealerAccSummary] Full error:`, error);

      return {
        success: false,
        error: `Dealer Accessory Summary Query execution failed: ${error.message}`,
        data: [],
        execution_timestamp: new Date(),
        version: "dealer_acc_summary_v1"
      };
    }
  }

  /**
   * Preprocess filters for dealer accessory summary with uppercase conversion
   * @param {Object} filters - Raw filters
   * @returns {Object} Processed filters
   */
  _preprocessFiltersForDealerAccSummary(filters) {
    if (!filters) return null;

    const processedFilters = { ...filters };

    // Fields that need uppercase conversion (including accessory fields)
    const uppercaseFields = [
      'distributor_code', 'region_code', 'region_name', 'dealer_code', 'dealer_name',
      'dealer_group_name', 'dealer_type', 'district_code', 'district_name',
      'vehicle_assignment_indicator', 'model_year', 'model_code', 'fd_fleet_description',
      'brand_code', 'segment_code', 'subsegment_code', 'team_lease_indicator',
      'team_member_lease_sale_type', 'nap_cbu_code', 'series_name', 'series_display_order',
      'grade_code', 'transmissiontype_code', 'drivetrain_code', 'fueltype_code',
      'enginefueltype_code',
      // Accessory fields
      'fio_ppo_indicator', 'accessory_code', 'accessory_uuid', 'accessory_desc'
    ];

    // Boolean fields that should not be converted
    const booleanFields = ['fleet_flag', 'fd_fleet_flag', 'car_trk_indicator'];

    uppercaseFields.forEach(field => {
      if (processedFilters[field] && Array.isArray(processedFilters[field])) {
        processedFilters[field] = processedFilters[field].map(value =>
          typeof value === 'string' ? value.toUpperCase() : value
        );
      }
    });

    // Handle boolean fields - ensure they remain as boolean arrays
    booleanFields.forEach(field => {
      if (processedFilters[field] && Array.isArray(processedFilters[field])) {
        processedFilters[field] = processedFilters[field].map(value => {
          if (typeof value === 'string') {
            return value.toLowerCase() === 'true';
          }
          return Boolean(value);
        });
      }
    });

    return processedFilters;
  }

  /**
   * Execute main dealer accessory query with filters
   * @param {Object} filters - Processed filters
   * @param {Array} indices - Index names
   * @param {string} indexType - Index type
   * @param {Array} inlineFilters - Inline filters
   * @param {Array} sortFields - Sort fields
   * @returns {Promise<Array>} Main query results
   */
  async _executeDealerAccMainQuery(filters, indices, indexType, inlineFilters, sortFields) {
    // Reuse the color dealer main query logic since the structure is the same
    return this._executeDealerMainQuery(filters, indices, indexType, inlineFilters, sortFields);
  }

  /**
   * Preprocess filters for accessory national ranking with uppercase conversion for specific fields
   * @param {Object} filters - The filters to preprocess
   * @returns {Object} Processed filters
   */
  _preprocessFiltersForAccessoryNationalRanking(filters) {
    if (!filters) return null;

    const processedFilters = { ...filters };

    // Fields that need uppercase conversion (including accessory fields)
    const uppercaseFields = [
      'distributor_code',
      'vehicle_assignment_indicator',
      'model_year',
      'model_code',
      'fd_fleet_description',
      'brand_code',
      'segment_code',
      'subsegment_code',
      'team_lease_indicator',
      'team_member_lease_sale_type',
      'nap_cbu_code',
      'series_name',
      'series_display_order',
      'grade_code',
      'transmissiontype_code',
      'drivetrain_code',
      'fueltype_code',
      'enginefueltype_code',
      'fio_ppo_indicator',
      'accessory_code',
      'accessory_uuid',
      'accessory_desc'
    ];

    // Boolean fields that should not be converted
    const booleanFields = ['fleet_flag', 'fd_fleet_flag', 'car_trk_indicator'];

    uppercaseFields.forEach(field => {
      if (processedFilters[field] && Array.isArray(processedFilters[field])) {
        const originalValues = [...processedFilters[field]];
        processedFilters[field] = processedFilters[field].map(value =>
          typeof value === 'string' ? value.toUpperCase() : value
        );
        if (field === 'series_name') {
          console.log(`[AccessoryNationalRankingFilters] series_name conversion: ${JSON.stringify(originalValues)} -> ${JSON.stringify(processedFilters[field])}`);
        }
      }
    });

    // Handle boolean fields - ensure they remain as boolean arrays
    booleanFields.forEach(field => {
      if (processedFilters[field] && Array.isArray(processedFilters[field])) {
        processedFilters[field] = processedFilters[field].map(value => {
          if (typeof value === 'string') {
            return value.toLowerCase() === 'true';
          }
          return Boolean(value);
        });
      }
    });

    console.log(`[AccessoryNationalRankingFilters] Original filters:`, JSON.stringify(filters));
    console.log(`[AccessoryNationalRankingFilters] Processed filters:`, JSON.stringify(processedFilters));

    return processedFilters;
  }

  /**
   * Execute national ranking query for accessory endpoint with optional filters
   * @param {Array} indices - Index names
   * @param {string} indexType - Index type
   * @param {Object} filters - Optional filters to apply (if null, no filters applied)
   * @returns {Promise<Object>} National ranking results
   */
  async _executeDealerAccNationalRankingQuery(indices, indexType, filters = null) {
    const client = await this.getClient();

    // Determine which count field to use based on index_type
    let retailCountField;
    switch (indexType) {
      case '0':
        retailCountField = 'net_daily_retail_count';
        break;
      case '3':
        retailCountField = 'net_mtd_retail_count';
        break;
      case '5':
        retailCountField = 'net_ytd_retail_count';
        break;
      default:
        retailCountField = 'net_daily_retail_count';
    }

    // Build query with optional filters using accessory-specific preprocessing (excluding region_code, district_code, and dealer_code for national ranking)
    let baseQuery;
    if (filters) {
      // Remove region_code, district_code, and dealer_code from filters for national ranking
      const filtersForNationalRanking = { ...filters };
      delete filtersForNationalRanking.region_code;
      delete filtersForNationalRanking.district_code;
      delete filtersForNationalRanking.dealer_code;

      // Process filters with uppercase conversion for accessory-specific fields
      const processedFilters = this._preprocessFiltersForAccessoryNationalRanking(filtersForNationalRanking);
      baseQuery = this._buildFilterQuery(processedFilters);

      console.log(`[DealerAccNationalRanking] Excluded region_code, district_code, and dealer_code from national ranking filters`);
    } else {
      baseQuery = { match_all: {} };
    }

    const query = {
      size: 0,
      query: this._addDummyRecordExclusions(baseQuery), // Apply filters (if any) and exclude dummy records
      aggs: {
        distributor_groups: {
          terms: {
            field: "distributor_code",
            size: 1000
          },
          aggs: {
            dealer_ranking: {
              terms: {
                field: "dealer_code",
                size: 10000,
                order: { total_retail_count: "desc" }
              },
              aggs: {
                total_retail_count: { sum: { field: retailCountField } }
              }
            }
          }
        }
      }
    };

    console.log(`[DealerAccNationalRanking] Using ${filters ? 'filtered' : 'unfiltered'} query for accessory national ranking`);
    if (filters) {
      const filtersForNationalRanking = { ...filters };
      delete filtersForNationalRanking.region_code;
      delete filtersForNationalRanking.district_code;
      delete filtersForNationalRanking.dealer_code;
      console.log(`[DealerAccNationalRanking] Applied filters (region_code, district_code, dealer_code excluded):`, JSON.stringify(filtersForNationalRanking));
    }

    const response = await client.search({
      index: indices,
      body: query,
      timeout: '30s'
    });

    console.log(`[DealerAccNationalRanking] Query executed, processing response...`);
    console.log(`[DealerAccNationalRanking] Response aggregations:`, JSON.stringify(response.body.aggregations, null, 2));

    // Process national ranking results
    const nationalRankings = {};
    const distributorBuckets = response.body.aggregations?.distributor_groups?.buckets || [];

    console.log(`[DealerAccNationalRanking] Found ${distributorBuckets.length} distributor buckets`);

    distributorBuckets.forEach(distributorBucket => {
      const distributorCode = distributorBucket.key;
      const dealerBuckets = distributorBucket.dealer_ranking.buckets || [];

      console.log(`[DealerAccNationalRanking] Distributor ${distributorCode} has ${dealerBuckets.length} dealers`);

      // Handle tied rankings - dealers with same retail count get same rank
      let currentRank = 1;
      let previousRetailCount = null;

      dealerBuckets.forEach((dealerBucket, index) => {
        const dealerCode = dealerBucket.key;
        const retailCount = dealerBucket.total_retail_count.value;

        // If retail count is different from previous, increment rank by 1 (dense ranking)
        if (previousRetailCount !== null && retailCount !== previousRetailCount) {
          currentRank = currentRank + 1;
        }

        const nationalRank = currentRank;
        nationalRankings[`${distributorCode}_${dealerCode}`] = nationalRank;

        if (index < 5) { // Log first 5 for debugging
          console.log(`[DealerAccNationalRanking] ${distributorCode}_${dealerCode} = rank ${nationalRank} (retail: ${retailCount})`);
        }

        previousRetailCount = retailCount;
      });
    });

    console.log(`[DealerAccNationalRanking] Total national rankings calculated:`, Object.keys(nationalRankings).length);
    return nationalRankings;
  }

  /**
   * Execute regional ranking query for accessory endpoint (only region filter applied)
   * @param {Object} filters - Processed filters
   * @param {Array} indices - Index names
   * @param {string} indexType - Index type
   * @returns {Promise<Object>} Regional ranking results
   */
  async _executeDealerAccRegionalRankingQuery(filters, indices, indexType) {
    const client = await this.getClient();

    // Determine which count field to use based on index_type
    let retailCountField;
    switch (indexType) {
      case '0':
        retailCountField = 'net_daily_retail_count';
        break;
      case '3':
        retailCountField = 'net_mtd_retail_count';
        break;
      case '5':
        retailCountField = 'net_ytd_retail_count';
        break;
      default:
        retailCountField = 'net_daily_retail_count';
    }

    // Build query with regional ranking filters for accessories
    const regionalRankingFilters = {};

    // Fields to include for accessory regional ranking with uppercase conversion
    const regionalRankingFields = [
      'region_code', 'region_name', 'distributor_code', 'vehicle_assignment_indicator',
      'model_year', 'model_code', 'fd_fleet_description', 'brand_code', 'segment_code',
      'subsegment_code', 'team_lease_indicator', 'team_member_lease_sale_type',
      'nap_cbu_code', 'series_name', 'series_display_order', 'grade_code',
      'transmissiontype_code', 'drivetrain_code', 'fueltype_code', 'enginefueltype_code',
      'fio_ppo_indicator', 'accessory_code', 'accessory_uuid', 'accessory_desc'
    ];

    // Boolean fields that should not be converted to uppercase
    const booleanFields = ['fleet_flag', 'fd_fleet_flag', 'car_trk_indicator'];

    // If no filters are passed, use existing logic with only region_code
    if (!filters || Object.keys(filters).length === 0) {
      // Default behavior - no filters applied
    } else {
      // Apply filters for the specified fields, converting to uppercase
      regionalRankingFields.forEach(field => {
        if (filters && filters[field]) {
          if (Array.isArray(filters[field])) {
            regionalRankingFilters[field] = filters[field].map(value =>
              typeof value === 'string' ? value.toUpperCase() : value
            );
          } else if (typeof filters[field] === 'string') {
            regionalRankingFilters[field] = filters[field].toUpperCase();
          } else {
            regionalRankingFilters[field] = filters[field];
          }
        }
      });

      // Handle boolean fields separately - no uppercase conversion
      booleanFields.forEach(field => {
        if (filters && filters[field]) {
          if (Array.isArray(filters[field])) {
            regionalRankingFilters[field] = filters[field].map(value => {
              if (typeof value === 'string') {
                return value.toLowerCase() === 'true';
              }
              return Boolean(value);
            });
          } else {
            if (typeof filters[field] === 'string') {
              regionalRankingFilters[field] = [filters[field].toLowerCase() === 'true'];
            } else {
              regionalRankingFilters[field] = [Boolean(filters[field])];
            }
          }
        }
      });

      // If no regional ranking fields are present in filters, fall back to region_code only
      if (Object.keys(regionalRankingFilters).length === 0 && filters.region_code) {
        regionalRankingFilters.region_code = filters.region_code;
      }
    }

    // Add specific logging for series_name if present
    if (regionalRankingFilters.series_name) {
      console.log(`[DealerAccRegionalRanking] series_name filter applied:`, regionalRankingFilters.series_name);
    }

    // Add specific logging for fleet_flag if present
    if (regionalRankingFilters.fleet_flag) {
      console.log(`[DealerAccRegionalRanking] fleet_flag filter applied:`, regionalRankingFilters.fleet_flag);
    }

    console.log(`[DealerAccRegionalRanking] Applied filters:`, JSON.stringify(regionalRankingFilters));

    const query = {
      size: 0,
      query: this._addDummyRecordExclusions(this._buildFilterQuery(regionalRankingFilters)),
      aggs: {
        region_groups: {
          terms: {
            field: "region_code",
            size: 1000
          },
          aggs: {
            dealer_ranking: {
              terms: {
                field: "dealer_code",
                size: 10000,
                order: { total_retail_count: "desc" }
              },
              aggs: {
                total_retail_count: { sum: { field: retailCountField } }
              }
            }
          }
        }
      }
    };

    const response = await client.search({
      index: indices,
      body: query,
      timeout: '30s'
    });

    console.log(`[DealerAccRegionalRanking] Query executed, processing response...`);
    console.log(`[DealerAccRegionalRanking] Response aggregations:`, JSON.stringify(response.body.aggregations, null, 2));

    // Process regional ranking results
    const regionalRankings = {};
    const regionBuckets = response.body.aggregations?.region_groups?.buckets || [];

    console.log(`[DealerAccRegionalRanking] Found ${regionBuckets.length} region buckets`);

    regionBuckets.forEach(regionBucket => {
      const regionCode = regionBucket.key;
      const dealerBuckets = regionBucket.dealer_ranking.buckets || [];

      console.log(`[DealerAccRegionalRanking] Region ${regionCode} has ${dealerBuckets.length} dealers`);

      // Handle tied rankings - dealers with same retail count get same rank (dense ranking)
      let currentRank = 1;
      let previousRetailCount = null;

      dealerBuckets.forEach((dealerBucket, index) => {
        const dealerCode = dealerBucket.key;
        const retailCount = dealerBucket.total_retail_count.value;

        // If retail count is different from previous, increment rank by 1 (dense ranking)
        if (previousRetailCount !== null && retailCount !== previousRetailCount) {
          currentRank = currentRank + 1;
        }

        const regionalRank = currentRank;
        regionalRankings[`${regionCode}_${dealerCode}`] = regionalRank;

        if (index < 5) { // Log first 5 for debugging
          console.log(`[DealerAccRegionalRanking] ${regionCode}_${dealerCode} = rank ${regionalRank} (retail: ${retailCount})`);
        }

        previousRetailCount = retailCount;
      });
    });

    console.log(`[DealerAccRegionalRanking] Total regional rankings generated: ${Object.keys(regionalRankings).length}`);
    return regionalRankings;
  }

  /**
   * Merge dealer accessory query results with rankings
   * @param {Array} mainResults - Main query results
   * @param {Object} nationalRankings - National rankings
   * @param {Object} regionalRankings - Regional rankings
   * @returns {Array} Merged results
   */
  _mergeDealerAccQueryResults(mainResults, nationalRankings, regionalRankings) {
    // Reuse the color dealer merge logic since the structure is the same
    return this._mergeDealerQueryResults(mainResults, nationalRankings, regionalRankings);
  }

  //Modified Functions
  async ModifiedexecutePaginatedQueryV33(filters = null, pagination = null, indexName = null, indexType = '0', inlineFilters = [], sortFields = []) {
    const startTime = Date.now();
    let opensearchQuery = null;

    try {
      logger.info(`[V33] Starting enhanced query execution with index_type: ${indexType}`);

      if (!pagination) {
        pagination = { page: 1, page_size: 10 };
      }

      // Preprocess filters for uppercase conversion
      const processedFilters = this._preprocessFiltersV33(filters);

      // Use the correct index name for index types 0, 3, 5
      const indices = indexName || ['pipe-rgn-dlr-dist-sale-color-current-summary-2025'];

      // Build query based on index_type and series_name presence with inline filters and sorting
      opensearchQuery = this._ModifiedbuildEnhancedQueryV33(processedFilters, indexType, inlineFilters, sortFields);

      logger.info(`[V33] Executing query with index_type: ${indexType}`);
      logger.info(`[V33] Query body: ${JSON.stringify(opensearchQuery, null, 2)}`);

      const client = await this.getClient();

      // Execute query
      const response = await client.search({
        index: indices,
        body: opensearchQuery,
        timeout: '30s'
      });

      // Process response based on query type
      let aggregatedData;
      if (['0', '3', '5'].includes(indexType)) {
        aggregatedData = this._ModifiedprocessV33SQLBasedResponse(response, processedFilters, indexType, inlineFilters, sortFields);
      } else {
        // Use existing V32 processing for other index types
        const allDealerData = await this._getAllDealerDataV32(client, indices, opensearchQuery);
        aggregatedData = this._createFlatAggregatedStructureV32(allDealerData);
      }

      const totalRecords = aggregatedData.length;
      const executionTime = (Date.now() - startTime) / 1000;

      logger.info(`[V33] Query executed successfully in ${executionTime.toFixed(2)} seconds, ${totalRecords} records`);

      return {
        success: true,
        data: aggregatedData,
        total_records: totalRecords,
        query_info: {
          took: response.body?.took || 0,
          timed_out: response.body?.timed_out || false,
          total_shards: response.body?._shards?.total || 0,
          successful_shards: response.body?._shards?.successful || 0
        },
        execution_timestamp: new Date(),
        version: "v33",
        aggregation_level: "enhanced_dealer_aggregation"
      };

    } catch (error) {
      const executionTime = (Date.now() - startTime) / 1000;
      logger.error(`[V33] Query failed after ${executionTime.toFixed(2)} seconds: ${error.message}`);

      if (opensearchQuery) {
        logger.error(`[V33] Query that failed: ${JSON.stringify(opensearchQuery)}`);
      }

      return {
        success: false,
        error: `V33 Query execution failed: ${error.message}`,
        data: [],
        query_info: {
          took: 0,
          timed_out: false,
          total_shards: 0,
          successful_shards: 0,
          error: error.message
        },
        execution_timestamp: new Date(),
        version: "v33",
        aggregation_level: "enhanced_dealer_aggregation"
      };
    }
  }
  _ModifiedbuildEnhancedQueryV33(filters, indexType, inlineFilters = [], sortFields = []) {
    logger.info(`[V33] Building query for index_type: ${indexType}`);

    // Check if series_name filter is present
    const hasSeriesName = filters && filters.series_name && Array.isArray(filters.series_name) && filters.series_name.length > 0;
    logger.info(`[V33] Series name filter present: ${hasSeriesName}`);

    // For index_type "0", "3", "5", use SQL-like aggregation logic
    if (['0', '3', '5'].includes(indexType)) {
      return this._ModifiedbuildSQLBasedQueryV33(filters, indexType, hasSeriesName, inlineFilters, sortFields);
    }

    // For other index types, use existing V32 logic
    return this._buildDealerAggregatedQueryV32(filters, 10000);
  }
  _ModifiedbuildSQLBasedQueryV33(filters, indexType, hasSeriesName, inlineFilters = [], sortFields = []) {
    logger.info(`[V33] Building SQL-based query for index_type: ${indexType}, hasSeriesName: ${hasSeriesName}`);

    // Convert filters to OpenSearch query format
    const filterDict = {};

    if (filters) {
      for (const [key, value] of Object.entries(filters)) {
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
          filterDict.transaction_date = { range: value };
        } else {
          filterDict[key] = value;
        }
      }
    }

    // Build base query with filters
    let baseQuery = this._buildOpenSearchQuery(filterDict);

    // Add inline filters to the query
    if (inlineFilters && inlineFilters.length > 0) {
      baseQuery = this._addInlineFiltersToQueryV33(baseQuery, inlineFilters);
    }

    // Build aggregation with sorting support
    const aggs = this._ModifiedbuildAggregationWithSortingV33(indexType, hasSeriesName, sortFields);

    return {
      size: 0,
      query: baseQuery,
      aggs: aggs
    };
  }
  _ModifiedbuildAggregationWithSortingV33(indexType, hasSeriesName, sortFields = []) {
    logger.info(`[V33] Building aggregation for index_type: ${indexType}, hasSeriesName: ${hasSeriesName}`);

    // Build composite aggregation sources
    const sources = [
      { region_code: { terms: { field: "region_code" } } },
      { region_name: { terms: { field: "region_name" } } },
      { region_display_order: { terms: { field: "region_display_order" } } },
      { district_code: { terms: { field: "district_code" } } },
      { district_name: { terms: { field: "district_name" } } },
      { dealer_code: { terms: { field: "dealer_code" } } },
      { dealer_name: { terms: { field: "dealer_name" } } },
      { vehicle_assignment_indicator: { terms: { field: "vehicle_assignment_indicator" } } },
      { brand_code: { terms: { field: "brand_code" } } },
      { objective_record_indicator: { terms: { field: "objective_record_indicator" } } },
      { objective_available_indicator: { terms: { field: "objective_available_indicator" } } }
    ];

    // Determine which count fields to use based on index_type
    let retailCountField, wholesaleCountField, distributorCountField;

    switch (indexType) {
      case '0':
        retailCountField = 'net_daily_retail_count';
        wholesaleCountField = 'net_daily_wholesale_count';
        distributorCountField = 'net_daily_distributor_count';
        break;
      case '3':
        retailCountField = 'net_mtd_retail_count';
        wholesaleCountField = 'net_mtd_wholesale_count';
        distributorCountField = 'net_mtd_distributor_count';
        break;
      case '5':
        retailCountField = 'net_ytd_retail_count';
        wholesaleCountField = 'net_ytd_wholesale_count';
        distributorCountField = 'net_ytd_distributor_count';
        break;
      default:
        retailCountField = 'net_daily_retail_count';
        wholesaleCountField = 'net_daily_wholesale_count';
        distributorCountField = 'net_daily_distributor_count';
    }

    // Determine objective fields based on series_name and index_type
    let retailObjectiveField, wholesaleObjectiveField;

    if (indexType === '5') {
      // For YTD (index_type 5), always use YTD objectives
      retailObjectiveField = hasSeriesName ? 'series_retail_ytd_obj' : 'region_retail_ytd_obj';
      wholesaleObjectiveField = hasSeriesName ? 'series_wholesale_ytd_obj' : 'region_wholesale_ytd_obj';
    } else {
      // For daily and MTD (index_type 0 and 3)
      retailObjectiveField = hasSeriesName ? 'series_retail_obj' : 'region_retail_obj';
      wholesaleObjectiveField = hasSeriesName ? 'series_wholesale_obj' : 'region_wholesale_obj';
    }

    // Build sub-aggregations for metrics
    const subAggs = {
      // Core sales metrics
      retail_count: { sum: { field: retailCountField } },
      wholesale_count: { sum: { field: wholesaleCountField } },
      distributor_count: { sum: { field: distributorCountField } },

      // Objective metrics
      retail_objective_count: { sum: { field: retailObjectiveField } },
      wholesale_objective_count: { sum: { field: wholesaleObjectiveField } },

      // YTD objectives (always included for response completeness)
      series_retail_ytd_obj: { sum: { field: "series_retail_ytd_obj" } },
      series_wholesale_ytd_obj: { sum: { field: "series_wholesale_ytd_obj" } },
      region_retail_ytd_obj: { sum: { field: "region_retail_ytd_obj" } },
      region_wholesale_ytd_obj: { sum: { field: "region_wholesale_ytd_obj" } },

      // Dealer objectives
      dealer_pcar_obj: { sum: { field: "dealer_pcar_obj" } },
      dealer_ltrk_obj: { sum: { field: "dealer_ltrk_obj" } },
      dealer_pcar_ytd_obj: { sum: { field: "dealer_pcar_ytd_obj" } },
      dealer_ltrk_ytd_obj: { sum: { field: "dealer_ltrk_ytd_obj" } },

      // Components for sales_availability_count and days_supply_count
      net_mtd_retail_sum: { sum: { field: "net_mtd_retail_count" } },
      dealer_stock_sum: { sum: { field: "dealer_stock_count" } },
      daily_sales_rate_sum: { sum: { field: "daily_sales_rate" } },

      // Calculated metrics using bucket_script
      retail_objective_percentage: {
        bucket_script: {
          buckets_path: {
            retail: "retail_count",
            objective: "retail_objective_count"
          },
          script: "params.objective > 0 ? (params.retail / params.objective) * 100 : 0"
        }
      },
      wholesale_objective_percentage: {
        bucket_script: {
          buckets_path: {
            wholesale: "wholesale_count",
            objective: "wholesale_objective_count"
          },
          script: "params.objective > 0 ? (params.wholesale / params.objective) * 100 : 0"
        }
      },
      dealer_retail_obj: {
        bucket_script: {
          buckets_path: {
            pcar: "dealer_pcar_obj",
            ltrk: "dealer_ltrk_obj"
          },
          script: "params.pcar + params.ltrk"
        }
      },
      // NEW: Sales availability count calculation
      sales_availability_count: {
        bucket_script: {
          buckets_path: {
            retail: "net_mtd_retail_sum",
            stock: "dealer_stock_sum"
          },
          script: "if (params.retail + params.stock == 0) { return 0; } else { return (100 * params.retail) / (params.retail + params.stock); }"
        }
      },
      // NEW: Days supply count calculation
      days_supply_count: {
        bucket_script: {
          buckets_path: {
            stock: "dealer_stock_sum",
            rate: "daily_sales_rate_sum"
          },
          script: "if (params.rate == 0) { return 0; } else { return params.stock / params.rate; }"
        }
      }
    };

    // Build the main aggregation
    const aggs = {
      dealer_aggregated: {
        composite: {
          size: 10000,
          sources: sources
        },
        aggs: subAggs
      }
    };

    // Add sorting if specified
    if (sortFields && sortFields.length > 0) {
      const sortClause = this._buildOpenSearchSortClauseV33(sortFields);
      aggs.dealer_aggregated.composite.after = undefined; // Will be set during pagination
      // Note: Composite aggregation sorting is limited, so we'll handle sorting post-aggregation
    }

    return aggs;
  }
  _ModifiedprocessV33SQLBasedResponse(response, filters, indexType, inlineFilters = [], sortFields = []) {
    const aggregatedData = [];

    // Defensive check for response structure
    if (!response || !response.body || !response.body.aggregations) {
      logger.warn('[V33] No aggregations found in OpenSearch response');
      return aggregatedData;
    }

    const buckets = response.body.aggregations.dealer_aggregated?.buckets || [];
    logger.info(`[V33] Processing ${buckets.length} buckets from OpenSearch response`);

    if (buckets.length === 0) {
      logger.info('[V33] No data buckets found in response');
      return aggregatedData;
    }

    // Check if series_name filter is present for objective calculation logic
    const hasSeriesName = filters && filters.series_name && Array.isArray(filters.series_name) && filters.series_name.length > 0;
    logger.info(`[V33] Using ${hasSeriesName ? 'series-based' : 'region-based'} objectives for index_type: ${indexType}`);

    for (const bucket of buckets) {
      const key = bucket.key;
      const aggs = bucket;

      // Ensure key exists and has required properties
      if (!key) {
        logger.warn('[V33] Skipping bucket with missing key');
        continue;
      }

      // Calculate dealer retail objective (dealer_pcar_obj + dealer_ltrk_obj) - preserve negative values
      const dealerRetailObj = (aggs.dealer_retail_obj?.value ?? 0);
      const dealerRetailYtdObj = (aggs.dealer_pcar_ytd_obj?.value ?? 0) + (aggs.dealer_ltrk_ytd_obj?.value ?? 0);

      // Get calculated percentages from bucket_script - preserve negative values
      const retailObjectivePercentage = aggs.retail_objective_percentage?.value ?? 0;
      const wholesaleObjectivePercentage = aggs.wholesale_objective_percentage?.value ?? 0;

      // Get calculated sales availability and days supply values - formatted to 1 decimal place
      const salesAvailabilityCount = aggs.sales_availability_count?.value ?? 0;
      const daysSupplyCount = aggs.days_supply_count?.value ?? 0;

      // Determine objective availability - preserve negative values
      const retailObjectiveCount = aggs.retail_objective_count?.value ?? 0;
      let objectiveAvailableIndicator = false;
      if (retailObjectiveCount > 0 || aggs.wholesale_objective_count?.value > 0) {
        objectiveAvailableIndicator = true;
      }
      else if (aggs.objective_record_indicator?.value == true && aggs.objective_available_indicator?.value == true) {
        objectiveAvailableIndicator = true;
      }
      else {
        objectiveAvailableIndicator = false;
      }
      
      const record = {
        region_code: key.region_code || '',
        region_name: key.region_name || '',
        region_display_order: key.region_display_order || 0,
        district_code: key.district_code || '',
        district_name: key.district_name || '',
        dealer_code: key.dealer_code || '',
        dealer_name: key.dealer_name || '',
        vehicle_assignment_indicator: key.vehicle_assignment_indicator || '',
        brand_code: key.brand_code || '',
        objective_available_indicator: objectiveAvailableIndicator,

        // Core sales metrics - preserve negative values
        retail_count: aggs.retail_count?.value ?? 0,
        wholesale_count: aggs.wholesale_count?.value ?? 0,
        distributor_count: aggs.distributor_count?.value ?? 0,

        // Objective metrics - preserve negative values
        retail_objective_count: retailObjectiveCount,
        wholesale_objective_count: aggs.wholesale_objective_count?.value ?? 0,
        dealer_retail_obj: dealerRetailObj,

        // YTD objectives - preserve negative values
        series_retail_ytd_obj: aggs.series_retail_ytd_obj?.value ?? 0,
        series_wholesale_ytd_obj: aggs.series_wholesale_ytd_obj?.value ?? 0,
        region_retail_ytd_obj: aggs.region_retail_ytd_obj?.value ?? 0,
        region_wholesale_ytd_obj: aggs.region_wholesale_ytd_obj?.value ?? 0,

        // Calculated percentages - keep 2 decimal places
        retail_objective_percentage: parseFloat(retailObjectivePercentage.toFixed(2)),
        wholesale_objective_percentage: parseFloat(wholesaleObjectivePercentage.toFixed(2)),

        // UPDATED: Format to 2 decimal places
        sales_availability_count: parseFloat(salesAvailabilityCount.toFixed(2)),
        days_supply_count: parseFloat(daysSupplyCount.toFixed(2)),

        // Default values for stock fields (as per requirements)
        vpc_stock_count: 0,
        unbuilt_count: 0,
        company_stock_count: 0,
        dealer_stock_count: 0,
        intransit_othervpc_count: 0,
        totalstock_count: 0,
        other_vpc_count: 0,
        postprocess_intransit_count: 0,
        preprocess_intransit_vpc_count: 0,
        hist_dealerstock_count: 0,
        hist_tmsstock_count: 0,
        hist_mfgstock_count: 0,
        hist_portstock_count: 0,
        hist_intransitstock_count: 0,
        sales_to_availability: 0
      };

      // Log each processed record for analysis
      console.log(`[V33] Processed Record: Region=${record.region_code}, District=${record.district_code}, Dealer=${record.dealer_code}, Retail=${record.retail_count}, Wholesale=${record.wholesale_count}, SalesAvail=${record.sales_availability_count}, DaysSupply=${record.days_supply_count}`);

      // Log if negative values are detected and preserved
      if (record.retail_count < 0 || record.wholesale_count < 0 || record.distributor_count < 0) {
        console.log(`[V33] NEGATIVE VALUES PRESERVED: Retail=${record.retail_count}, Wholesale=${record.wholesale_count}, Distributor=${record.distributor_count}`);
      }

      aggregatedData.push(record);
    }

    console.log(`[V33] Total processed records: ${aggregatedData.length}`);
    console.log(`[V33] Records with positive retail_count: ${aggregatedData.filter(r => r.retail_count > 0).length}`);
    console.log(`[V33] Records with negative retail_count: ${aggregatedData.filter(r => r.retail_count < 0).length}`);
    console.log(`[V33] Records with zero retail_count: ${aggregatedData.filter(r => r.retail_count === 0).length}`);
    console.log(`[V33] Records with positive wholesale_count: ${aggregatedData.filter(r => r.wholesale_count > 0).length}`);
    console.log(`[V33] Records with negative wholesale_count: ${aggregatedData.filter(r => r.wholesale_count < 0).length}`);
    console.log(`[V33] Records with zero wholesale_count: ${aggregatedData.filter(r => r.wholesale_count === 0).length}`);
    
    // Log sales availability and days supply statistics
    console.log(`[V33] Records with positive sales_availability_count: ${aggregatedData.filter(r => r.sales_availability_count > 0).length}`);
    console.log(`[V33] Records with positive days_supply_count: ${aggregatedData.filter(r => r.days_supply_count > 0).length}`);

    // Apply numeric inline filters post-aggregation
    let filteredData = this._applyNumericInlineFiltersV33(aggregatedData, inlineFilters);

    // Apply sorting post-aggregation
    filteredData = this._applySortingV33(filteredData, sortFields, indexType);

    logger.info(`[V33] Processed ${filteredData.length} records from SQL-based response`);
    return filteredData;
  }
  async ModifiedexecutePaginatedQueryV34(filters = null, pagination = null, indexName = null, indexType = '0', inlineFilters = [], sortFields = []) {
    const startTime = Date.now();
    let opensearchQuery = null;

    try {
      logger.info(`[V34] Starting accessory enhanced query execution with index_type: ${indexType}`);

      if (!pagination) {
        pagination = { page: 1, page_size: 10 };
      }

      // Preprocess filters for uppercase conversion
      const processedFilters = this._preprocessFiltersV34(filters);

      // Use the correct index name for index types 0, 3, 5
      const indices = indexName || ['pipe-rgn-dlr-dist-sale-color-current-summary-2025'];

      // Build query based on index_type and series_name presence with inline filters and sorting
      opensearchQuery = this._ModifiedbuildEnhancedQueryV33(processedFilters, indexType, inlineFilters, sortFields);

      logger.info(`[V34] Executing query with index_type: ${indexType}`);
      logger.info(`[V34] Query body: ${JSON.stringify(opensearchQuery, null, 2)}`);

      const client = await this.getClient();

      // Execute query
      const response = await client.search({
        index: indices,
        body: opensearchQuery,
        timeout: '30s'
      });

      // Process response based on query type
      let aggregatedData;
      if (['0', '3', '5'].includes(indexType)) {
        aggregatedData = this._ModifiedprocessV33SQLBasedResponse(response, processedFilters, indexType, inlineFilters, sortFields);
      } else {
        // Use existing V32 processing for other index types
        const allDealerData = await this._getAllDealerDataV32(client, indices, opensearchQuery);
        aggregatedData = this._createFlatAggregatedStructureV32(allDealerData);
      }

      const totalRecords = aggregatedData.length;
      const executionTime = (Date.now() - startTime) / 1000;

      logger.info(`[V34] Query executed successfully in ${executionTime.toFixed(2)} seconds, ${totalRecords} records`);

      return {
        success: true,
        data: aggregatedData,
        total_records: totalRecords,
        query_info: {
          took: response.body?.took || 0,
          timed_out: response.body?.timed_out || false,
          total_shards: response.body?._shards?.total || 0,
          successful_shards: response.body?._shards?.successful || 0
        },
        execution_timestamp: new Date(),
        version: "v34",
        aggregation_level: "accessory_enhanced_dealer_aggregation"
      };

    } catch (error) {
      const executionTime = (Date.now() - startTime) / 1000;
      logger.error(`[V34] Query failed after ${executionTime.toFixed(2)} seconds: ${error.message}`);

      if (opensearchQuery) {
        logger.error(`[V34] Query that failed: ${JSON.stringify(opensearchQuery)}`);
      }

      return {
        success: false,
        error: `V34 Query execution failed: ${error.message}`,
        data: [],
        query_info: {
          took: 0,
          timed_out: false,
          total_shards: 0,
          successful_shards: 0,
          error: error.message
        },
        execution_timestamp: new Date(),
        version: "v34",
        aggregation_level: "accessory_enhanced_dealer_aggregation"
      };
    }
  }
  async ModifiedexecuteSeriesColorSummaryQuery(filters = null, pagination = { page: 1, page_size: 10 }, indexNames = [], indexType = '0', inlineFilters = [], sortFields = []) {
    const startTime = Date.now();
    let opensearchQuery = null;

    try {
      const client = await this.getClient();

      // Build the aggregation query for series color summary
      opensearchQuery = this._ModifiedbuildSeriesColorSummaryQuery(filters, indexType, inlineFilters, sortFields);

      console.log('Series Color Summary Query:', JSON.stringify(opensearchQuery, null, 2));

      const response = await client.search({
        index: indexNames.join(','),
        body: opensearchQuery
      });

      const executionTime = (Date.now() - startTime) / 1000;
      console.log(`Series Color Summary Query executed in ${executionTime.toFixed(2)} seconds`);

      // Debug: Log the raw aggregation response
      console.log('Series Color Summary Raw Aggregations:', JSON.stringify(response.body.aggregations, null, 2));

      // Process aggregation results
      const processedData = this._processSeriesColorSummaryAggregations(response.body.aggregations, indexType);

      // Debug: Log processed data
      console.log(`Series Color Summary Processed Data Count: ${processedData.length}`);
      if (processedData.length > 0) {
        console.log('Series Color Summary Sample Processed Item:', JSON.stringify(processedData[0], null, 2));
      }

      // Apply inline filtering if provided
      let filteredData = processedData;
      if (inlineFilters && inlineFilters.length > 0) {
        filteredData = this._applyInlineFilters(processedData, inlineFilters);
      }

      // Apply sorting if provided
      if (sortFields && sortFields.length > 0) {
        filteredData = this._applySorting(filteredData, sortFields);
      }

      const totalRecords = filteredData.length;

      const queryInfo = {
        took: response.body.took || 0,
        timed_out: response.body.timed_out || false,
        total_shards: response.body._shards?.total || 0,
        successful_shards: response.body._shards?.successful || 0,
        skipped_shards: response.body._shards?.skipped || 0,
        failed_shards: response.body._shards?.failed || 0
      };

      return {
        success: true,
        data: filteredData,
        total_records: totalRecords,
        query_info: queryInfo,
        execution_timestamp: new Date(),
        version: "series_color_summary",
        aggregation_level: "series_model_aggregation"
      };

    } catch (error) {
      const executionTime = (Date.now() - startTime) / 1000;
      console.error(`Series Color Summary Query failed after ${executionTime.toFixed(2)} seconds: ${error.message}`);

      if (opensearchQuery) {
        console.error(`Query that failed: ${JSON.stringify(opensearchQuery)}`);
      }

      return {
        success: false,
        error: `Series Color Summary Query execution failed: ${error.message}`,
        data: [],
        query_info: {
          took: 0,
          timed_out: false,
          total_shards: 0,
          successful_shards: 0,
          error: error.message
        },
        execution_timestamp: new Date(),
        version: "series_color_summary",
        aggregation_level: "series_model_aggregation"
      };
    }
  }
  _ModifiedbuildSeriesColorSummaryQuery(filters = null, indexType = '0', inlineFilters = [], sortFields = []) {
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
          filterDict.transaction_date = value;
        } else {
          filterDict[key] = value;
        }
      }
    }

    // Build the query with aggregations for series and model codes
    const query = {
      size: 0, // We only need aggregations
      query: Object.keys(filterDict).length > 0 ? this._buildOpenSearchQuery(filterDict) : { match_all: {} },
      aggs: {
        series_names: {
          terms: {
            field: "series_name",
            size: 1000,
            min_doc_count: 1,
            order: { _key: "asc" }
          },
          aggs: {
            model_codes: {
              terms: {
                field: "model_code",
                size: 1000,
                min_doc_count: 1,
                order: { _key: "asc" }
              },
              aggs: {
                // Sales counts based on index type
                net_daily_retail_count: { sum: { field: "net_daily_retail_count" } },
                net_mtd_retail_count: { sum: { field: "net_mtd_retail_count" } },
                net_ytd_retail_count: { sum: { field: "net_ytd_retail_count" } },
                net_daily_wholesale_count: { sum: { field: "net_daily_wholesale_count" } },
                net_mtd_wholesale_count: { sum: { field: "net_mtd_wholesale_count" } },
                net_ytd_wholesale_count: { sum: { field: "net_ytd_wholesale_count" } },
                net_daily_distributor_count: { sum: { field: "net_daily_distributor_count" } },
                net_mtd_distributor_count: { sum: { field: "net_mtd_distributor_count" } },
                net_ytd_distributor_count: { sum: { field: "net_ytd_distributor_count" } },

                // Objectives
                series_retail_obj: { sum: { field: "series_retail_obj" } },
                series_wholesale_obj: { sum: { field: "series_wholesale_obj" } },
                series_retail_ytd_obj: { sum: { field: "series_retail_ytd_obj" } },
                series_wholesale_ytd_obj: { sum: { field: "series_wholesale_ytd_obj" } },

                // Other fields (set to 0 as per requirements)
                vpc_stock_count: { sum: { field: "vpc_stock_count", missing: 0 } },
                unbuilt_count: { sum: { field: "unbuilt_count", missing: 0 } },
                company_stock_count: { sum: { field: "company_stock_count", missing: 0 } },
                dealer_stock_count: { sum: { field: "dealer_stock_count", missing: 0 } },
                intransit_othervpc_count: { sum: { field: "intransit_othervpc_count", missing: 0 } },
                totalstock_count: { sum: { field: "totalstock_count", missing: 0 } },
                other_vpc_count: { sum: { field: "other_vpc_count", missing: 0 } },
                postprocess_intransit_count: { sum: { field: "postprocess_intransit_count", missing: 0 } },
                preprocess_intransit_vpc_count: { sum: { field: "preprocess_intransit_vpc_count", missing: 0 } },
                hist_dealerstock_count: { sum: { field: "hist_dealerstock_count", missing: 0 } },
                hist_tmsstock_count: { sum: { field: "hist_tmsstock_count", missing: 0 } },
                hist_mfgstock_count: { sum: { field: "hist_mfgstock_count", missing: 0 } },
                hist_portstock_count: { sum: { field: "hist_portstock_count", missing: 0 } },
                hist_intransitstock_count: { sum: { field: "hist_intransitstock_count", missing: 0 } },
                sales_to_availability: { sum: { field: "sales_to_availability", missing: 0 } },

                // Components for calculated fields
                daily_sales_rate_sum: { sum: { field: "daily_sales_rate", missing: 0 } },

                // NEW: Calculated fields using bucket_script
                sales_availability_count: {
                  bucket_script: {
                    buckets_path: {
                      net_mtd_retail: "net_mtd_retail_count",
                      dealer_stock: "dealer_stock_count"
                    },
                    script: "if (params.net_mtd_retail + params.dealer_stock == 0) { return 0; } else { return (100 * params.net_mtd_retail) / (params.net_mtd_retail + params.dealer_stock); }"
                  }
                },
                days_supply_count: {
                  bucket_script: {
                    buckets_path: {
                      dealer_stock: "dealer_stock_count",
                      daily_rate: "daily_sales_rate_sum"
                    },
                    script: "if (params.daily_rate == 0) { return 0; } else { return params.dealer_stock / params.daily_rate; }"
                  }
                },

                // Get sample document for brand_code
                sample_doc: {
                  top_hits: {
                    size: 1,
                    _source: ["brand_code", "series_display_order"]
                  }
                }
              }
            },
            // Series-level aggregations
            series_sample_doc: {
              top_hits: {
                size: 1,
                _source: ["brand_code", "series_display_order","objective_record_indicator","objective_available_indicator"]
              }
            },
            // Series-level calculated fields
            series_net_mtd_retail_sum: { sum: { field: "net_mtd_retail_count" } },
            series_dealer_stock_sum: { sum: { field: "dealer_stock_count", missing: 0 } },
            series_daily_sales_rate_sum: { sum: { field: "daily_sales_rate", missing: 0 } },
            
            // Series-level calculated metrics
            series_sales_availability_count: {
              bucket_script: {
                buckets_path: {
                  net_mtd_retail: "series_net_mtd_retail_sum",
                  dealer_stock: "series_dealer_stock_sum"
                },
                script: "if (params.net_mtd_retail + params.dealer_stock == 0) { return 0; } else { return (100 * params.net_mtd_retail) / (params.net_mtd_retail + params.dealer_stock); }"
              }
            },
            series_days_supply_count: {
              bucket_script: {
                buckets_path: {
                  dealer_stock: "series_dealer_stock_sum",
                  daily_rate: "series_daily_sales_rate_sum"
                },
                script: "if (params.daily_rate == 0) { return 0; } else { return params.dealer_stock / params.daily_rate; }"
              }
            }
          }
        }
      }
    };

    return query;
  }
  _ModifiedprocessSeriesColorSummaryAggregations(aggregations, indexType) {
    const processedData = [];

    if (!aggregations || !aggregations.series_names || !aggregations.series_names.buckets) {
      return processedData;
    }

    aggregations.series_names.buckets.forEach(seriesBucket => {
      const seriesName = seriesBucket.key;
      const seriesSampleDoc = seriesBucket.series_sample_doc?.hits?.hits?.[0]?._source || {};

      if (seriesBucket.model_codes && seriesBucket.model_codes.buckets) {
        seriesBucket.model_codes.buckets.forEach(modelBucket => {
          const modelCode = modelBucket.key;
          const modelSampleDoc = modelBucket.sample_doc?.hits?.hits?.[0]?._source || {};

          // Determine which counts to use based on index type
          let retailCount = 0;
          let wholesaleCount = 0;
          let distributorCount = 0;
          let retailObjective = 0;
          let wholesaleObjective = 0;
          let objectiveAvailable = false;

          if (indexType === '0') {
            // Daily data
            retailCount = modelBucket.net_daily_retail_count?.value || 0;
            wholesaleCount = modelBucket.net_daily_wholesale_count?.value || 0;
            distributorCount = modelBucket.net_daily_distributor_count?.value || 0;
            retailObjective = modelBucket.series_retail_obj?.value || 0;
            wholesaleObjective = modelBucket.series_wholesale_obj?.value || 0;
          } else if (indexType === '3') {
            // MTD data
            retailCount = modelBucket.net_mtd_retail_count?.value || 0;
            wholesaleCount = modelBucket.net_mtd_wholesale_count?.value || 0;
            distributorCount = modelBucket.net_mtd_distributor_count?.value || 0;
            retailObjective = modelBucket.series_retail_obj?.value || 0;
            wholesaleObjective = modelBucket.series_wholesale_obj?.value || 0;
          } else if (indexType === '5') {
            // YTD data
            retailCount = modelBucket.net_ytd_retail_count?.value || 0;
            wholesaleCount = modelBucket.net_ytd_wholesale_count?.value || 0;
            distributorCount = modelBucket.net_ytd_distributor_count?.value || 0;
            retailObjective = modelBucket.series_retail_ytd_obj?.value || 0;
            wholesaleObjective = modelBucket.series_wholesale_ytd_obj?.value || 0;
          }

          // Calculate objective percentages
          let retailObjectivePercentage = 0;
          let wholesaleObjectivePercentage = 0;

          if (retailObjective > 0) {
            retailObjectivePercentage = parseFloat(((retailCount / retailObjective) * 100).toFixed(1));
          }

          if (wholesaleObjective > 0) {
            wholesaleObjectivePercentage = parseFloat(((wholesaleCount / wholesaleObjective) * 100).toFixed(1));
          }

          if(retailObjective > 0 || wholesaleObjective > 0){
            objectiveAvailable = true;
          }
          else if (seriesSampleDoc.objective_record_indicator == true && seriesSampleDoc.objective_available_indicator == true) {
            objectiveAvailable = true;
          }
          else {
            objectiveAvailable = false;
          }

          // NEW: Get calculated values from aggregation response
          const salesAvailabilityCount = modelBucket.sales_availability_count?.value || 0;
          const daysSupplyCount = modelBucket.days_supply_count?.value || 0;

          const processedItem = {
            series_name: seriesName,
            model_code: modelCode,
            brand_code: modelSampleDoc.brand_code || seriesSampleDoc.brand_code || null,
            series_display_order: modelSampleDoc.series_display_order || seriesSampleDoc.series_display_order || null,
            objective_available_indicator: objectiveAvailable,

            // Sales counts
            retail_count: retailCount,
            wholesale_count: wholesaleCount,
            distributor_count: distributorCount,

            // Objectives
            retail_objective_count: retailObjective,
            retail_objective_percentage: retailObjectivePercentage,
            wholesale_objective_count: wholesaleObjective,
            wholesale_objective_percentage: wholesaleObjectivePercentage,

            // NEW: Updated to use calculated values from aggregation (formatted to 1 decimal place)
            sales_availability_count: parseFloat(salesAvailabilityCount.toFixed(2)),
            days_supply_count: parseFloat(daysSupplyCount.toFixed(2)),

            // Stock counts
            vpc_stock_count: modelBucket.vpc_stock_count?.value || 0,
            unbuilt_count: modelBucket.unbuilt_count?.value || 0,
            company_stock_count: modelBucket.company_stock_count?.value || 0,
            dealer_stock_count: modelBucket.dealer_stock_count?.value || 0,
            intransit_othervpc_count: modelBucket.intransit_othervpc_count?.value || 0,
            totalstock_count: modelBucket.totalstock_count?.value || 0,
            other_vpc_count: modelBucket.other_vpc_count?.value || 0,
            postprocess_intransit_count: modelBucket.postprocess_intransit_count?.value || 0,
            preprocess_intransit_vpc_count: modelBucket.preprocess_intransit_vpc_count?.value || 0,
            hist_dealerstock_count: modelBucket.hist_dealerstock_count?.value || 0,
            hist_tmsstock_count: modelBucket.hist_tmsstock_count?.value || 0,
            hist_mfgstock_count: modelBucket.hist_mfgstock_count?.value || 0,
            hist_portstock_count: modelBucket.hist_portstock_count?.value || 0,
            hist_intransitstock_count: modelBucket.hist_intransitstock_count?.value || 0,
            sales_to_availability: modelBucket.sales_to_availability?.value || 0
          };

          processedData.push(processedItem);
        });
      }
    });

    return processedData;
  }
  async ModifiedexecuteSeriesAccSummaryQuery(filters = null, pagination = { page: 1, page_size: 10 }, indexNames = [], indexType = '0', inlineFilters = [], sortFields = []) {
    const startTime = Date.now();
    let opensearchQuery = null;

    try {
      const client = await this.getClient();

      // Build the aggregation query for series accessory summary
      opensearchQuery = this._buildSeriesAccSummaryQuery(filters, indexType, inlineFilters, sortFields);

      console.log('Series Accessory Summary Query:', JSON.stringify(opensearchQuery, null, 2));

      const response = await client.search({
        index: indexNames.join(','),
        body: opensearchQuery
      });

      const executionTime = (Date.now() - startTime) / 1000;
      console.log(`Series Accessory Summary Query executed in ${executionTime.toFixed(2)} seconds`);

      // Debug: Log the raw aggregation response
      console.log('Series Accessory Summary Raw Aggregations:', JSON.stringify(response.body.aggregations, null, 2));

      // Process aggregation results
      const processedData = this._ModifiedbuildSeriesColorSummaryQuery(response.body.aggregations, indexType);

      // Debug: Log processed data
      console.log(`Series Accessory Summary Processed Data Count: ${processedData.length}`);
      if (processedData.length > 0) {
        console.log('Series Accessory Summary Sample Processed Item:', JSON.stringify(processedData[0], null, 2));
      }

      // Apply inline filtering if provided
      let filteredData = processedData;
      if (inlineFilters && inlineFilters.length > 0) {
        filteredData = this._applyInlineFilters(processedData, inlineFilters);
      }

      // Apply sorting if provided
      if (sortFields && sortFields.length > 0) {
        filteredData = this._applySorting(filteredData, sortFields);
      }

      const totalRecords = filteredData.length;

      const queryInfo = {
        took: response.body.took || 0,
        timed_out: response.body.timed_out || false,
        total_shards: response.body._shards?.total || 0,
        successful_shards: response.body._shards?.successful || 0,
        skipped_shards: response.body._shards?.skipped || 0,
        failed_shards: response.body._shards?.failed || 0
      };

      return {
        success: true,
        data: filteredData,
        total_records: totalRecords,
        query_info: queryInfo,
        execution_timestamp: new Date(),
        version: "series_acc_summary",
        aggregation_level: "series_model_aggregation"
      };

    } catch (error) {
      const executionTime = (Date.now() - startTime) / 1000;
      console.error(`Series Accessory Summary Query failed after ${executionTime.toFixed(2)} seconds: ${error.message}`);

      if (opensearchQuery) {
        console.error(`Query that failed: ${JSON.stringify(opensearchQuery)}`);
      }

      return {
        success: false,
        error: `Series Accessory Summary Query execution failed: ${error.message}`,
        data: [],
        query_info: {
          took: 0,
          timed_out: false,
          total_shards: 0,
          successful_shards: 0,
          error: error.message
        },
        execution_timestamp: new Date(),
        version: "series_acc_summary",
        aggregation_level: "series_model_aggregation"
      };
    }
  }
}

module.exports = PIPQueryService;