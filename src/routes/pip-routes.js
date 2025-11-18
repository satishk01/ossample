// routes/pip-routes.js
const express = require('express');
const router = express.Router();
const Joi = require('joi');
const { validateRequest } = require('../middleware/validation');
const PIPQueryService = require('../services/pip-query-service');
const { FilterCondition, PaginationRequest } = require('../models/request-models');
const settings = require('../config/settings');
const YEARLY_INDEX_PREFIX = 'pip-inventory';
const COLOR_INDEX = 'pipe-rgn-dlr-dist-sale-inv-color-daily-summ';
const ACCESSORY_INDEX = 'pipe-rgn-dlr-dist-sale-inv-accessory-daily-summ';
const SALES_INV_INDEX = 'pipe-rgn-dlr-dist-sale-inv-color-daily-summ';
const OBJECTIVE_INDEX = 'pipe-rgn-sales-objectives-year-summ';
const RETAIL_VEHICLE_INDEX = 'pipe-vh-vehicle-info';

// Define calculated fields that support numeric filtering
const CALCULATED_FIELDS = new Set([
  "company_stock",
  "dealer_stock",
  "in_transit_to_other_vpc",
  "other_vpc_stock",
  "post_process_in_transit_vpc",
  "pre_process_in_transit_vpc",
  "total_stock",
  "retail",
  "retail_yoy",
  "retail_mom",
  "retail_obj",
  "wholesale_obj",
  "wholesale",
  "vpc_stock",
  "unbuilt_stock"
]);

// Logger function for index_par
const logIndexPar = (endpointName, indexPar) => {
  if (indexPar) {
    console.log(`[INFO] [${endpointName}] index_par: ${indexPar}`);
  }
};

/**
 * Transform flat data array into hierarchical structure grouped by region, district, and dealer
 * @param {Array} flatData - Array of flat data objects
 * @returns {Object} Hierarchical structure with regionSummary
 */
const transformToHierarchicalStructure = (flatData) => {
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

  // Initialize totals with all numeric fields
  const numericFields = [
    'sales_availability_count', 'days_supply_count', 'retail_count', 'vpc_stock_count',
    'unbuilt_count', 'company_stock_count', 'dealer_stock_count', 'intransit_othervpc_count',
    'totalstock_count', 'other_vpc_count', 'postprocess_intransit_count', 'preprocess_intransit_vpc_count',
    'wholesale_count', 'hist_dealerstock_count', 'hist_tmsstock_count', 'hist_mfgstock_count',
    'hist_portstock_count', 'hist_intransitstock_count', 'sales_to_availability'
  ];

  numericFields.forEach(field => {
    totals[field] = 0;
  });

  flatData.forEach(item => {
    const regionCode = item.region_code;
    const regionName = item.region_name;
    const districtCode = item.district_code;
    const dealerCode = item.dealer_code;
    const dealerName = item.dealer_name;
    const brandCode = item.brand_code || null;

    // Initialize region if not exists
    if (!regionMap.has(regionCode)) {
      regionMap.set(regionCode, {
        region_code: regionCode,
        region_name: regionName,
        brand_code: brandCode,
        districts: new Map(),
        ...Object.fromEntries(numericFields.map(field => [field, 0]))
      });
    }

    const region = regionMap.get(regionCode);

    // Initialize district if not exists
    if (!region.districts.has(districtCode)) {
      region.districts.set(districtCode, {
        district_code: districtCode,
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
        ...Object.fromEntries(numericFields.map(field => [field, 0]))
      });
    }

    const dealer = district.dealers.get(dealerCode);

    // Aggregate numeric values (excluding calculated fields)
    numericFields.forEach(field => {
      if (field !== 'sales_to_availability') {
        const value = parseInt(item[field]) || 0;
        dealer[field] += value;
        district[field] += value;
        region[field] += value;
        totals[field] += value;
      }
    });
  });

  // Convert maps to arrays and structure the response
  const regions = Array.from(regionMap.values()).map(region => {
    // Extract districts map and numeric fields separately
    const { districts, ...regionFields } = region;

    // Calculate sales_to_availability for region: retail_count/(retail_count+dealer_stock_count)
    const retailCount = regionFields.retail_count || 0;
    const dealerStockCount = regionFields.dealer_stock_count || 0;
    const denominator = retailCount + dealerStockCount;
    regionFields.sales_to_availability = denominator > 0 ? parseFloat((retailCount / denominator).toFixed(4)) : 0;

    return {
      ...regionFields, // This includes region_code, region_name, and all numeric fields including sales_to_availability
      districts: Array.from(districts.values()).map(district => {
        // Extract dealers map and numeric fields separately
        const { dealers, ...districtFields } = district;

        // Calculate sales_to_availability for district
        const districtRetailCount = districtFields.retail_count || 0;
        const districtDealerStockCount = districtFields.dealer_stock_count || 0;
        const districtDenominator = districtRetailCount + districtDealerStockCount;
        districtFields.sales_to_availability = districtDenominator > 0 ? parseFloat((districtRetailCount / districtDenominator).toFixed(4)) : 0;

        return {
          ...districtFields, // This includes district_code and all numeric fields including sales_to_availability
          dealers: Array.from(dealers.values()).map(dealer => {
            // Calculate sales_to_availability for dealer
            const dealerRetailCount = dealer.retail_count || 0;
            const dealerDealerStockCount = dealer.dealer_stock_count || 0;
            const dealerDenominator = dealerRetailCount + dealerDealerStockCount;
            dealer.sales_to_availability = dealerDenominator > 0 ? parseFloat((dealerRetailCount / dealerDenominator).toFixed(4)) : 0;

            return dealer;
          })
        };
      })
    };
  });

  // Calculate overall sales_to_availability for totals
  const totalRetailCount = totals.retail_count || 0;
  const totalDealerStockCount = totals.dealer_stock_count || 0;
  const totalDenominator = totalRetailCount + totalDealerStockCount;
  totals.sales_to_availability = totalDenominator > 0 ? parseFloat((totalRetailCount / totalDenominator).toFixed(4)) : 0;

  return {
    regionSummary: {
      count: regions.length,
      regions: regions,
      totals: totals
    }
  };
};
function applyDealerNameFilter(dataItem, field, condition, value) {
  console.log(`[applyDealerNameFilter] Starting filter - field: "${field}", condition: "${condition}", value: "${value}" (type: ${typeof value})`);

  // Handle dealer_name field with conditional logic
  if (field === 'dealer_name') {
    const isNumeric = !isNaN(value) && !isNaN(parseFloat(value));
    console.log(`[applyDealerNameFilter] dealer_name field detected, isNumeric: ${isNumeric}`);

    if (isNumeric) {
      // Search dealerCode for numeric values
      const dealerCodeValue = dataItem.dealerCode || dataItem.dealer_code;
      console.log(`[applyDealerNameFilter] Numeric value detected, searching dealerCode - dealerCodeValue: ${dealerCodeValue} (from dealerCode: ${dataItem.dealerCode}, dealer_code: ${dataItem.dealer_code})`);

      if (dealerCodeValue === undefined || dealerCodeValue === null) {
        console.log(`[applyDealerNameFilter] dealerCode value is null/undefined, returning false`);
        return false;
      }

      let result;
      switch (condition) {
        case '>=':
          result = dealerCodeValue >= parseFloat(value);
          console.log(`[applyDealerNameFilter] Condition '>=' - ${dealerCodeValue} >= ${parseFloat(value)} = ${result}`);
          return result;
        case '<=':
          result = dealerCodeValue <= parseFloat(value);
          console.log(`[applyDealerNameFilter] Condition '<=' - ${dealerCodeValue} <= ${parseFloat(value)} = ${result}`);
          return result;
        case '=':
          result = dealerCodeValue == value; // Use == for type coercion
          console.log(`[applyDealerNameFilter] Condition '=' - ${dealerCodeValue} == ${value} = ${result}`);
          return result;
        case '>':
          result = dealerCodeValue > parseFloat(value);
          console.log(`[applyDealerNameFilter] Condition '>' - ${dealerCodeValue} > ${parseFloat(value)} = ${result}`);
          return result;
        case '<':
          result = dealerCodeValue < parseFloat(value);
          console.log(`[applyDealerNameFilter] Condition '<' - ${dealerCodeValue} < ${parseFloat(value)} = ${result}`);
          return result;
        case 'contains':
          result = String(dealerCodeValue).toLowerCase().includes(String(value).toLowerCase());
          console.log(`[applyDealerNameFilter] Condition 'contains' - "${String(dealerCodeValue).toLowerCase()}" contains "${String(value).toLowerCase()}" = ${result}`);
          return result;
        default:
          console.log(`[applyDealerNameFilter] Unknown condition "${condition}" for numeric dealerCode, returning true`);
          return true;
      }
    } else {
      // Search dealerName for string values
      const dealerNameValue = dataItem.dealerName || dataItem.dealer_name;
      console.log(`[applyDealerNameFilter] String value detected, searching dealerName - dealerNameValue: "${dealerNameValue}" (from dealerName: "${dataItem.dealerName}", dealer_name: "${dataItem.dealer_name}")`);

      if (dealerNameValue === undefined || dealerNameValue === null) {
        console.log(`[applyDealerNameFilter] dealerName value is null/undefined, returning false`);
        return false;
      }

      let result;
      switch (condition) {
        case '=':
          result = String(dealerNameValue).toLowerCase() === String(value).toLowerCase();
          console.log(`[applyDealerNameFilter] Condition '=' - "${String(dealerNameValue).toLowerCase()}" === "${String(value).toLowerCase()}" = ${result}`);
          return result;
        case 'contains':
          result = String(dealerNameValue).toLowerCase().includes(String(value).toLowerCase());
          console.log(`[applyDealerNameFilter] Condition 'contains' - "${String(dealerNameValue).toLowerCase()}" includes "${String(value).toLowerCase()}" = ${result}`);
          return result;
        case '>=':
        case '<=':
        case '>':
        case '<':
          // String comparison for non-contains conditions
          const nameCompare = String(dealerNameValue).toLowerCase().localeCompare(String(value).toLowerCase());
          console.log(`[applyDealerNameFilter] String comparison - "${String(dealerNameValue).toLowerCase()}" vs "${String(value).toLowerCase()}" = ${nameCompare}`);
          switch (condition) {
            case '>=':
              result = nameCompare >= 0;
              console.log(`[applyDealerNameFilter] Condition '>=' - nameCompare >= 0 = ${result}`);
              return result;
            case '<=':
              result = nameCompare <= 0;
              console.log(`[applyDealerNameFilter] Condition '<=' - nameCompare <= 0 = ${result}`);
              return result;
            case '>':
              result = nameCompare > 0;
              console.log(`[applyDealerNameFilter] Condition '>' - nameCompare > 0 = ${result}`);
              return result;
            case '<':
              result = nameCompare < 0;
              console.log(`[applyDealerNameFilter] Condition '<' - nameCompare < 0 = ${result}`);
              return result;
            default:
              console.log(`[applyDealerNameFilter] Unknown string comparison condition "${condition}", returning true`);
              return true;
          }
        default:
          console.log(`[applyDealerNameFilter] Unknown condition "${condition}" for string dealerName, returning true`);
          return true;
      }
    }
  }

  // Handle other dealer-related fields (dealerCode, dealerName, dealer_code)
  if (field === 'dealerCode' || field === 'dealer_code') {
    const fieldValue = dataItem.dealerCode || dataItem.dealer_code;
    console.log(`[applyDealerNameFilter] Processing dealerCode field - fieldValue: ${fieldValue} (from dealerCode: ${dataItem.dealerCode}, dealer_code: ${dataItem.dealer_code})`);

    if (fieldValue === undefined || fieldValue === null) {
      console.log(`[applyDealerNameFilter] dealerCode fieldValue is null/undefined, returning false`);
      return false;
    }

    let result;
    switch (condition) {
      case '>=':
        result = fieldValue >= parseFloat(value);
        console.log(`[applyDealerNameFilter] dealerCode '>=' - ${fieldValue} >= ${parseFloat(value)} = ${result}`);
        return result;
      case '<=':
        result = fieldValue <= parseFloat(value);
        console.log(`[applyDealerNameFilter] dealerCode '<=' - ${fieldValue} <= ${parseFloat(value)} = ${result}`);
        return result;
      case '=':
        result = fieldValue == value;
        console.log(`[applyDealerNameFilter] dealerCode '=' - ${fieldValue} == ${value} = ${result}`);
        return result;
      case '>':
        result = fieldValue > parseFloat(value);
        console.log(`[applyDealerNameFilter] dealerCode '>' - ${fieldValue} > ${parseFloat(value)} = ${result}`);
        return result;
      case '<':
        result = fieldValue < parseFloat(value);
        console.log(`[applyDealerNameFilter] dealerCode '<' - ${fieldValue} < ${parseFloat(value)} = ${result}`);
        return result;
      case 'contains':
        result = String(fieldValue).toLowerCase().includes(String(value).toLowerCase());
        console.log(`[applyDealerNameFilter] dealerCode 'contains' - "${String(fieldValue).toLowerCase()}" includes "${String(value).toLowerCase()}" = ${result}`);
        return result;
      default:
        console.log(`[applyDealerNameFilter] Unknown condition "${condition}" for dealerCode, returning true`);
        return true;
    }
  }

  if (field === 'dealerName') {
    const fieldValue = dataItem.dealerName || dataItem.dealer_name;
    console.log(`[applyDealerNameFilter] Processing dealerName field - fieldValue: "${fieldValue}" (from dealerName: "${dataItem.dealerName}", dealer_name: "${dataItem.dealer_name}")`);

    if (fieldValue === undefined || fieldValue === null) {
      console.log(`[applyDealerNameFilter] dealerName fieldValue is null/undefined, returning false`);
      return false;
    }

    let result;
    switch (condition) {
      case '=':
        result = String(fieldValue).toLowerCase() === String(value).toLowerCase();
        console.log(`[applyDealerNameFilter] dealerName '=' - "${String(fieldValue).toLowerCase()}" === "${String(value).toLowerCase()}" = ${result}`);
        return result;
      case 'contains':
        result = String(fieldValue).toLowerCase().includes(String(value).toLowerCase());
        console.log(`[applyDealerNameFilter] dealerName 'contains' - "${String(fieldValue).toLowerCase()}" includes "${String(value).toLowerCase()}" = ${result}`);
        return result;
      case '>=':
      case '<=':
      case '>':
      case '<':
        const nameCompare = String(fieldValue).toLowerCase().localeCompare(String(value).toLowerCase());
        console.log(`[applyDealerNameFilter] dealerName string comparison - "${String(fieldValue).toLowerCase()}" vs "${String(value).toLowerCase()}" = ${nameCompare}`);
        switch (condition) {
          case '>=':
            result = nameCompare >= 0;
            console.log(`[applyDealerNameFilter] dealerName '>=' - nameCompare >= 0 = ${result}`);
            return result;
          case '<=':
            result = nameCompare <= 0;
            console.log(`[applyDealerNameFilter] dealerName '<=' - nameCompare <= 0 = ${result}`);
            return result;
          case '>':
            result = nameCompare > 0;
            console.log(`[applyDealerNameFilter] dealerName '>' - nameCompare > 0 = ${result}`);
            return result;
          case '<':
            result = nameCompare < 0;
            console.log(`[applyDealerNameFilter] dealerName '<' - nameCompare < 0 = ${result}`);
            return result;
          default:
            console.log(`[applyDealerNameFilter] Unknown dealerName string comparison condition "${condition}", returning true`);
            return true;
        }
      default:
        console.log(`[applyDealerNameFilter] Unknown condition "${condition}" for dealerName, returning true`);
        return true;
    }
  }
  // For other fields, use standard filtering logic
  console.log(`[applyDealerNameFilter] Processing standard field "${field}"`);
  const fieldValue = dataItem[field];
  console.log(`[applyDealerNameFilter] Standard field value: ${fieldValue}`);

  if (fieldValue === undefined || fieldValue === null) {
    console.log(`[applyDealerNameFilter] Standard field value is null/undefined, returning false`);
    return false;
  }

  let result;
  switch (condition) {
    case '>=':
      result = fieldValue >= value;
      console.log(`[applyDealerNameFilter] Standard '>=' - ${fieldValue} >= ${value} = ${result}`);
      return result;
    case '<=':
      result = fieldValue <= value;
      console.log(`[applyDealerNameFilter] Standard '<=' - ${fieldValue} <= ${value} = ${result}`);
      return result;
    case '=':
      result = fieldValue === value;
      console.log(`[applyDealerNameFilter] Standard '=' - ${fieldValue} === ${value} = ${result}`);
      return result;
    case '>':
      result = fieldValue > value;
      console.log(`[applyDealerNameFilter] Standard '>' - ${fieldValue} > ${value} = ${result}`);
      return result;
    case '<':
      result = fieldValue < value;
      console.log(`[applyDealerNameFilter] Standard '<' - ${fieldValue} < ${value} = ${result}`);
      return result;
    case 'contains':
      result = String(fieldValue).toLowerCase().includes(String(value).toLowerCase());
      console.log(`[applyDealerNameFilter] Standard 'contains' - "${String(fieldValue).toLowerCase()}" includes "${String(value).toLowerCase()}" = ${result}`);
      return result;
    default:
      console.log(`[applyDealerNameFilter] Unknown standard condition "${condition}", returning true`);
      return true;
  }
}

// Initialize PIPQueryService once
const pipService = new PIPQueryService();

// Root endpoint schema
const rootSchema = Joi.object({
  index_par: Joi.string().optional().description('Index parameter for logging/tracking')
});

// GET / - Root endpoint
router.get('/', validateRequest({ query: rootSchema }), async (req, res, next) => {
  try {
    logIndexPar('root', req.query.index_par);
    return res.json({
      message: "PIP Data API",
      version: "1.0.0",
      docs: "/docs",
      health: "/health"
    });
  } catch (error) {
    next(error);
  }
});

// Health check schema
const healthSchema = Joi.object({
  index_par: Joi.string().optional().description('Index parameter for logging/tracking')
});

// GET /health - Health check endpoint
router.get('/health', validateRequest({ query: healthSchema }), async (req, res, next) => {
  try {
    logIndexPar('health_check', req.query.index_par);

    // Get OpenSearch client and check health
    const client = await pipService.getClient();
    const health = await client.cluster.health();

    return res.json({
      status: "healthy",
      opensearch_status: health.body?.status || "unknown",
      cluster_name: health.body?.cluster_name || "unknown",
      timestamp: health.body?.timestamp || null
    });
  } catch (error) {
    next(error);
  }
});

const kpiChatRes = async (apiName = "", req, next) => {
  const indexPar = req.query.index_par;
  logIndexPar('post_pip_data', indexPar);
  const filtersData = req.body.filters || {};
  // Determine which index to use based on index_type
  const indexType = req.body.index_type;
  let indexName;
  if (indexType === 'multi') {
    indexName = [`${YEARLY_INDEX_PREFIX}-2024,${YEARLY_INDEX_PREFIX}-2025`];
  } else if (indexType === 'currmth') {
    indexName = [`${YEARLY_INDEX_PREFIX}-2024,${YEARLY_INDEX_PREFIX}-2022`];
  } else {
    indexName = [`${YEARLY_INDEX_PREFIX}-2024`];
  }

  // Build filters object dynamically
  const filterKwargs = {};

  // Define all supported field mappings
  const allFieldMappings = {
    // Core fields (support both legacy and conditional formats)
    region_code: "region_code",
    dealer_code: "dealer_code",
    // Conditional-only fields
    timePeriod: "timePeriod",
    distributor: "distributor",
    brand: "brand",
    segment: "segment",
    fleetIndicator: "fleetIndicator",
    model_year: "model_year",
    series: "series",
    drivetrain: "drivetrain",
    fio_accessories: "fio_accessories",
    ppo_accessories: "ppo_accessories",
    exterior_color: "exterior_color",
    interior_color: "interior_color"
  };

  // Core fields that support legacy format
  const coreFields = new Set(["region_code", "dealer_code"]);

  // Process all fields uniformly
  for (const [requestField, filterField] of Object.entries(allFieldMappings)) {
    if (requestField in filtersData) {
      const fieldData = filtersData[requestField];

      // Check if it's conditional format
      if (fieldData && typeof fieldData === 'object' && 'condition' in fieldData && 'value' in fieldData) {
        // Conditional format
        try {
          filterKwargs[filterField] = {
            condition: fieldData.condition,
            value: fieldData.value
          };
          console.log(`Processed conditional filter ${requestField}: ${JSON.stringify(filterKwargs[filterField])}`);
        } catch (error) {
          const validationError = new Error(`Invalid conditional filter format for ${requestField}: ${error.message}`);
          validationError.statusCode = 400;
          return next(validationError);
        }
      } else {
        // Legacy format - only allowed for core fields
        if (coreFields.has(requestField)) {
          // Convert to list if needed for legacy format
          let value = fieldData;
          if (!Array.isArray(value)) {
            value = [value];
          }
          filterKwargs[filterField] = value;
          console.log(`Processed legacy filter ${requestField}: ${JSON.stringify(value)}`);
        } else {
          // Non-core fields must use conditional format
          const validationError = new Error(`Field '${requestField}' must use conditional format with 'condition' and 'value' properties`);
          validationError.statusCode = 400;
          return next(validationError);
        }
      }
    }
  }

  console.log(`Built filter kwargs: ${JSON.stringify(filterKwargs)}`);

  // Create filters object only if we have filter conditions
  const filters = Object.keys(filterKwargs).length > 0 ? filterKwargs : null;

  console.log(`Final filters object: ${JSON.stringify(filters)}`);

  // Execute query
  const result = await pipService.executePaginatedQuery(filters, null, indexName);

  if (!result.success) {
    return next(new Error(result.error));
  }

  // Build detailed filter summary
  const filterSummaryData = buildFilterSummary(filterKwargs);
  return filterSummaryData;
}
// Schema for KPI Tiles Info endpoint
const kpiChartSchema = Joi.object({
  index_par: Joi.string().optional().description('Index parameter for logging/tracking'),
  timePeriod: Joi.string().required(),
  distributor: Joi.array().items(Joi.string()).required(),
  brand: Joi.array().items(Joi.string()).required(),
  segment: Joi.array().items(Joi.string()).required(),
  fleetIndicator: Joi.boolean().required(),
  region_code: Joi.array().items(Joi.string()).required(),
  dealer_code: Joi.array().items(Joi.string()).required(),
  model_year: Joi.array().items(Joi.number()).required(),
  series: Joi.array().items(Joi.string()).required(),
  drivetrain: Joi.array().items(Joi.string()).required(),
  fio_accessories: Joi.array().items(Joi.string()).required(),
  ppo_accessories: Joi.array().items(Joi.string()).required(),
  exterior_color: Joi.array().items(Joi.string()).required(),
  interior_color: Joi.array().items(Joi.string()).required(),
  index_type: Joi.string().valid('currmth', 'prevmth', 'mtd', 'prevyr').default('currmth').description('Index type: single (2022 only) or multi (2022,2023)')
});

// POST /api/v1/pip/kpi-tiles-info - Returns static KPI tiles info
router.post('/api/v1/pip/kpi-tiles-info', validateRequest({ body: kpiChartSchema }), async (req, res, next) => {
  try {
    kpiChatRes("kpi-tiles-info", req, next);
    return res.json({
      data: {
        kpiTilesInfo: {
          netRetailSales: {
            count: 248,
            bySeries: [
              { count: 97, salesSeriesName: "TACOMA 4X4" },
              { count: 54, salesSeriesName: "TUNDRA 4X4" },
              { count: 26, salesSeriesName: "RAV4 HV" }
            ]
          },
          wholesales: {
            count: 212,
            bySeries: [
              { count: 89, salesSeriesName: "TACOMA 4X4" },
              { count: 50, salesSeriesName: "TUNDRA 4X4" },
              { count: 19, salesSeriesName: "TACOMA 4X2" }
            ]
          },
          salesAvailability: {
            count: 64.9,
            bySeries: [
              { count: 67.6, salesSeriesName: "RAV4" },
              { count: 67.5, salesSeriesName: "TACOMA 4X4" },
              { count: 67.5, salesSeriesName: "TACOMA 4X2" }
            ]
          },
          dailySalesRate: {
            count: 8634,
            bySeries: [
              { count: 1234, salesSeriesName: "RAV4" },
              { count: 874, salesSeriesName: "TACOMA 4X4" },
              { count: 796, salesSeriesName: "TACOMA 4X2" }
            ]
          },
          daysSupply: {
            count: 12.7,
            bySeries: [
              { count: 19, salesSeriesName: "RAV4 HV" },
              { count: 17, salesSeriesName: "TACOMA 4X4" },
              { count: 16.8, salesSeriesName: "TUNDRA 4X4" }
            ]
          },
          salesVelocity: {
            count: 16,
            bySeries: [
              { count: 19, salesSeriesName: "RAV4 HV" },
              { count: 17, salesSeriesName: "TACOMA 4X4" },
              { count: 16.8, salesSeriesName: "TUNDRA 4X4" }
            ]
          }
        }
      }
    });
  }
  catch (error) {
    next(error);
  }

});

// POST /api/v1/pip/chart-sbs - Returns sales by series chart
router.post('/api/v1/pip/chart-sbs', validateRequest({ body: kpiChartSchema }), async (req, res, next) => {
  try {
    kpiChatRes("chart-sbs", req, next);
    return res.json({
      netRetailSales: {
        count: 224483,
        bySeries: [
          { count: 38000, percentage: 12.3, salesSeriesName: "RAV4 HV" },
          { count: 24000, percentage: 12.3, salesSeriesName: "CAMRY HYBRID" },
          { count: 18975, percentage: 12.3, salesSeriesName: "COROLLA CROSS" },
          { count: 16455, percentage: 12.3, salesSeriesName: "TUNDRA 4X4" },
          { count: 15648, percentage: 12.3, salesSeriesName: "TUNDRA 4X4" },
          { count: 124121, percentage: 45.3, salesSeriesName: "All Other Series" }
        ]
      }
    });
  }
  catch (error) {
    next(error);
  }
});

const postPipRequestDataSchema = Joi.object({
  globalFilters: Joi.object({
    distributor: Joi.array().items(Joi.string()).optional(),
    brand: Joi.array().items(Joi.string()).optional(),
    segment: Joi.array().items(Joi.string()).optional(),
    fleetIndicator: Joi.boolean().optional(),
    regionCode: Joi.array().items(Joi.string()).optional(),
    dealerCode: Joi.array().items(Joi.string()).optional(),
    modelYear: Joi.array().items(Joi.string()).optional(),
    salesSeriesName: Joi.array().items(Joi.string()).optional(),
    drivetrainName: Joi.array().items(Joi.string()).optional(),
    fioAccessory: Joi.array().items(Joi.string()).optional(),
    ppoAccessory: Joi.array().items(Joi.string()).optional(),
    exteriorColor: Joi.array().items(Joi.string()).optional(),
    interiorColor: Joi.array().items(Joi.string()).optional(),
    //district_code: Joi.array().items(Joi.string()).optional(),
    // date_range: Joi.object({
    //   gte: Joi.string().optional(),
    //   lte: Joi.string().optional()
    // }).optional(),
    // Additional filters
    //modelCode: Joi.array().items(Joi.string()).optional(),
    //car_trk_indicator: Joi.array().items(Joi.string()).optional(),
    //dealer_type: Joi.array().items(Joi.string()).optional(),
    //team_lease_indicator: Joi.array().items(Joi.string()).optional(),
    //transmissiontype_code: Joi.array().items(Joi.string()).optional(),
    //accessory_code: Joi.array().items(Joi.string()).optional(),
    //sls_ccyymm: Joi.array().items(Joi.string()).optional().description('Filter by year-month in CCYYMM format (e.g., "202407")')
  }).optional(),
  inlinefilter: Joi.array().items(
    Joi.object({
      field: Joi.string().valid(
        'companyStock', 'dealerStock', 'inTransitToOtherVPC', 'otherVPCStock',
        'postProcessInTransitVPC', 'preProcessInTransitVPC', 'totalStock',
        'retail', 'retailYoY', 'retailMoM', 'retailObj', 'wholesaleObj',
        'wholesale', 'vpcStock', 'unbuilt', 'salesAvailability', 'daysSupply',
        'nvsTmsStock', 'nvsDealerStock', 'nvsPortStock', 'nvsMfgStock', 'nvsInTransitStock',
        'distributorSale'
      ).required(),
      condition: Joi.string().valid('gte', 'lte', 'eq', 'gt', 'lt', 'notEq').required(),
      value: Joi.number().required()
    })
  ).optional().description('Inline filters to apply to region data after retrieval'),
  orderBy: Joi.array().items(
    Joi.object({
      field: Joi.string().valid(
        'companyStock', 'dealerStock', 'inTransitToOtherVPC', 'otherVPCStock',
        'postProcessInTransitVPC', 'preProcessInTransitVPC', 'totalStock',
        'retail', 'retailYoY', 'retailMoM', 'retailObj', 'wholesaleObj',
        'wholesale', 'vpcStock', 'unbuilt', 'regionCode', 'regionName'
      ).required(),
      order: Joi.string().valid('asc', 'desc').required()
    })
  ).optional().description('Fields to sort region data by after retrieval'),
  page: Joi.object({
    page: Joi.number().integer().min(1).default(1),
    limit: Joi.number().integer().min(1).max(100).default(10)
  }).default({ page: 1, limit: 10 }),
  index_type: Joi.string().valid('currmth', 'prevmth', 'mtd', 'prevyr').default('currmth').description('Index type: single (2022 only) or multi (2022,2023)')
});

// POST /sales-stock/regionSummary - Get region summary data using post
router.post('/sales-stock/regionSummary', validateRequest({ body: postPipRequestDataSchema }), async (req, res, next) => {
  try {
    console.log('entered the regionSummary function');
    const indexPar = req.query.index_par;
    logIndexPar('post_pip_data', indexPar);

    // Determine which index to use based on index_type
    const indexType = req.body.index_type;
    let indexName;
    if (indexType === 'multi') {
      indexName = [`${YEARLY_INDEX_PREFIX}-2024,${YEARLY_INDEX_PREFIX}-2025`];
    } else if (indexType === 'currmth') {
      indexName = [`${YEARLY_INDEX_PREFIX}-2024,${YEARLY_INDEX_PREFIX}-2022`];
    } else {
      indexName = [`${YEARLY_INDEX_PREFIX}-2024`];
    }

    console.log('index name is :', indexName);
    console.log('before calling the query');

    // Create a copy of filters to avoid modifying the original request
    const filters = req.body.globalFilters ? { ...req.body.globalFilters } : null;
    console.log('filters is');
    console.log(JSON.stringify(filters));
    // Handle sales_ccyymm filter if provided
    // if (filters && filters.sls_ccyymm && filters.sls_ccyymm.length > 0) {
    //   console.log(`Applying sls_ccyymm filter with values: ${filters.sls_ccyymm.join(', ')}`);
    // }

    // Execute query to get data without pagination first
    const initialResult = await pipService.executeRegionSummaryPaginatedQuery(
      filters || null,
      { page: 1, page_size: 10000 }, // Get a large page to apply filtering and sorting first
      indexName
    );

    if (!initialResult.success) {
      return next(new Error(initialResult.error));
    }

    // Get regions data to apply inline filtering and sorting
    let regionsData = initialResult.data || [];

    // Apply inline filtering if provided
    if (req.body.inlinefilter && Array.isArray(req.body.inlinefilter) && req.body.inlinefilter.length > 0) {
      console.log(`Applying ${req.body.inlinefilter.length} inline filters to region data`);

      regionsData = regionsData.filter(region => {
        // Apply all filters to the region (AND logic)
        return req.body.inlinefilter.every(filter => {
          const fieldValue = region[filter.field];

          if (fieldValue === undefined || fieldValue === null) {
            return false;
          }

          // Apply the condition
          switch (filter.condition) {
            case 'gte':
              return fieldValue >= filter.value;
            case 'lte':
              return fieldValue <= filter.value;
            case 'eq':
              return fieldValue === filter.value;
            case 'gt':
              return fieldValue > filter.value;
            case 'lt':
              return fieldValue < filter.value;
            case 'notEq':
              return fieldValue != filter.value;
            default:
              return true;
          }
        });
      });

      console.log(`After inline filtering, ${regionsData.length} regions remain`);
    }

    // Apply sorting if provided
    if (req.body.orderBy && Array.isArray(req.body.orderBy) && req.body.orderBy.length > 0) {
      console.log(`Applying sorting by ${req.body.orderBy.length} fields`);

      regionsData.sort((a, b) => {
        // Apply sort fields in order (prioritizing earlier sort fields)
        for (const sort of req.body.orderBy) {
          const fieldA = a[sort.field];
          const fieldB = b[sort.field];

          // Handle undefined/null values
          if (fieldA === undefined && fieldB !== undefined) return sort.order === 'asc' ? -1 : 1;
          if (fieldA !== undefined && fieldB === undefined) return sort.order === 'asc' ? 1 : -1;
          if (fieldA === undefined && fieldB === undefined) continue;

          // Compare values
          if (fieldA < fieldB) return sort.order === 'asc' ? -1 : 1;
          if (fieldA > fieldB) return sort.order === 'asc' ? 1 : -1;
        }

        // If all sort fields are equal
        return 0;
      });
    }

    console.log('regionsData--', regionsData);
    // Now apply pagination to the filtered and sorted data
    const pagination = req.body.page || { page: 1, limit: 10 };
    const startIndex = (pagination.page - 1) * pagination.limit;
    const endIndex = startIndex + pagination.limit;
    const paginatedData = regionsData.slice(startIndex, endIndex);

    console.log('paginatedData2--', paginatedData);
    // Update pagination info
    const updatedPaginationInfo = {
      current_page: pagination.page,
      page_size: pagination.limit,
      total_pages: Math.ceil(regionsData.length / pagination.limit),
      has_next_page: endIndex < regionsData.length,
      has_previous_page: startIndex > 0
    };

    //calculate total and add in region response
    const totals = {
      nvsTmsStock: 0, nvsDealerStock: 0, nvsPortStock: 0, nvsMfgStock: 0, nvsInTransitStock: 0,
      companyStock: 0, dealerStock: 0, inTransitToOtherVPC: 0, otherVPCStock: 0,
      postProcessInTransitVPC: 0, preProcessInTransitVPC: 0, totalStock: 0, unbuilt: 0,
      vpcStock: 0, retail: 0, retailYoY: 0, retailMoM: 0, retailObj: 0, wholesaleObj: 0,
      wholesale: 0, distributorSale: 0, salesAvailability: 0, daysSupply: 0
    };

    // Define sum fields for aggregation
    const sumFields = [
      'companyStock', 'dealerStock', 'inTransitToOtherVPC', 'otherVPCStock',
      'postProcessInTransitVPC', 'preProcessInTransitVPC', 'totalStock',
      'retail', 'retailYoY', 'retailMoM', 'retailObj', 'wholesaleObj',
      'wholesale', 'vpcStock', 'unbuilt', 'salesAvailability', 'daysSupply',
      'nvsTmsStock', 'nvsDealerStock', 'nvsPortStock', 'nvsMfgStock', 'nvsInTransitStock',
      'distributorSale'
    ];

    for (const record of paginatedData) {
      for (const field of sumFields) {
        const value = record[field] || 0;
        if (typeof value === 'number') {
          totals[field] += value;
        }
      }
    }

    console.log('paginatedData1--', paginatedData);
    // Prepare response
    const result = {
      ...initialResult,
      data: { regionSummary: { regions: paginatedData, totals } },
      pagination: updatedPaginationInfo
    };

    // Add sales_ccyymm filter info to response if it was applied
    if (filters && filters.sls_ccyymm && filters.sls_ccyymm.length > 0) {
      result.applied_sls_ccyymm_filter = filters.sls_ccyymm;
    }

    return res.json(result);
  } catch (error) {
    console.error('Error in POST /api/v1/pip/regionSummary:', error);
    next(error);
  }
});
//Use pipeline-routs for charts//
const postChartSchema = Joi.object({
  filters: Joi.object({
    // Core location filters
    region_code: Joi.array().items(Joi.string()).optional(),
    region_name: Joi.array().items(Joi.string()).optional(),
    district_code: Joi.array().items(Joi.string()).optional(),
    district_name: Joi.array().items(Joi.string()).optional(),
    dealer_code: Joi.array().items(Joi.string()).optional(),
    dealer_name: Joi.array().items(Joi.string()).optional(),
    dealer_group_name: Joi.array().items(Joi.string()).optional(),
    dealer_type: Joi.array().items(Joi.string()).optional(),

    // Distributor filters
    distributor_code: Joi.array().items(Joi.string()).optional(),

    // Date filters
    transaction_date: Joi.object({
      gte: Joi.string().optional().description('Start date (yyyy-MM-dd)'),
      lte: Joi.string().optional().description('End date (yyyy-MM-dd)')
    }).optional(),
    sls_ccyymm: Joi.array().items(Joi.string()).optional().description('Filter by year-month in CCYYMM format (e.g., "202407")'),

    // Vehicle filters
    vehicle_assignment_indicator: Joi.array().items(Joi.string()).optional(),
    model_year: Joi.array().items(Joi.string()).optional(),
    model_code: Joi.array().items(Joi.string()).optional(),
    fleet_flag: Joi.array().items(Joi.boolean()).optional(),
    fd_fleet_flag: Joi.array().items(Joi.boolean()).optional(),
    fd_fleet_description: Joi.array().items(Joi.string()).optional(),

    // Brand and segment filters
    brand_code: Joi.array().items(Joi.string()).optional(),
    segment_code: Joi.array().items(Joi.string()).optional(),
    subsegment_code: Joi.array().items(Joi.string()).optional(),

    // Vehicle characteristics
    car_trk_indicator: Joi.array().items(Joi.string()).optional(),
    team_lease_indicator: Joi.array().items(Joi.string()).optional(),
    team_member_lease_sale_type: Joi.array().items(Joi.string()).optional(),
    nap_cbu_code: Joi.array().items(Joi.string()).optional(),

    // Series and grade filters
    series_name: Joi.array().items(Joi.string()).optional(),
    series_display_order: Joi.array().items(Joi.string()).optional(),
    grade_code: Joi.array().items(Joi.string()).optional(),

    // Technical specifications
    transmissiontype_code: Joi.array().items(Joi.string()).optional(),
    drivetrain_code: Joi.array().items(Joi.string()).optional(),
    fueltype_code: Joi.array().items(Joi.string()).optional(),
    enginefueltype_code: Joi.array().items(Joi.string()).optional(),

    // Accessory filters (replacing color filters)
    fio_ppo_indicator: Joi.array().items(Joi.boolean()).optional(),
    accessory_code: Joi.array().items(Joi.string()).optional(),
    accessory_desc: Joi.array().items(Joi.string()).optional(),

    // Color filters
    exterior_color_code: Joi.array().items(Joi.string()).optional(),
    exterior_color_desc: Joi.array().items(Joi.string()).optional(),
    interior_color_code: Joi.array().items(Joi.string()).optional(),
    interior_trim_color_desc: Joi.array().items(Joi.string()).optional()
  }).optional().description('Global filters object'),
  index_type: Joi.string().valid('0', '1', '2', '3', '4', '5', '6', '7').default('currmth').description('Index type for date-based index selection')
});

router.post('/sales-stock/salesBySegmentChart', validateRequest({ body: postChartSchema }), async (req, res, next) => {
  try {
    console.log('entered the salesBySegmentChart function');
    const indexPar = req.query.index_par;
    logIndexPar('post_sales_by_segment_chart', indexPar);
    console.log('Request body:', req.body);

    const { filters, indexName } = pipService.getRequestData(req, ACCESSORY_INDEX, SALES_INV_INDEX);

    console.log('Final index name:', indexName);

    const initialResult = await pipService.executeSalesChartQuery(
      filters || null,
      indexName,
      "segment_code"
    );
    console.log('Final filters object:', JSON.stringify(filters));

    if (!initialResult.success) {
      return next(new Error(initialResult.error));
    }

    return res.json(initialResult.data);


  } catch (error) {
    console.error('Error in POST /sales-stock/salesBySegmentChart:', error);
    next(error);
  }
});

router.post('/sales-stock/salesBySeriesChart', validateRequest({ body: postChartSchema }), async (req, res, next) => {
  try {
    console.log('entered the salesBySeriesChart function');
    const indexPar = req.query.index_par;
    logIndexPar('post_sales_by_series_chart', indexPar);
    console.log('Request body:', req.body);

    const { filters, indexName } = pipService.getRequestData(req, ACCESSORY_INDEX, SALES_INV_INDEX);

    console.log('Final index name:', indexName);

    const initialResult = await pipService.executeSalesChartQuery(
      filters || null,
      indexName,
      "series_name"
    );
    console.log('Final filters object:', JSON.stringify(filters));

    if (!initialResult.success) {
      return next(new Error(initialResult.error));
    }

    return res.json(initialResult.data);


  } catch (error) {
    console.error('Error in POST /sales-stock/salesBySegmentChart:', error);
    next(error);
  }
});

router.post('/sales-stock/salesByEngineChart', validateRequest({ body: postChartSchema }), async (req, res, next) => {
  try {
    console.log('entered the salesByEngineChart function');
    const indexPar = req.query.index_par;
    logIndexPar('post_sales_by_engine_chart', indexPar);
    console.log('Request body:', req.body);

    const { filters, indexName } = pipService.getRequestData(req, ACCESSORY_INDEX, SALES_INV_INDEX);

    console.log('Final index name:', indexName);

    const initialResult = await pipService.executeSalesChartQuery(
      filters || null,
      indexName,
      "fueltype_code"
    );
    console.log('Final filters object:', JSON.stringify(filters));

    if (!initialResult.success) {
      return next(new Error(initialResult.error));
    }

    return res.json(initialResult.data);


  } catch (error) {
    console.error('Error in POST /sales-stock/salesBySegmentChart:', error);
    next(error);
  }
});
//Use pipeline-routs for charts//
// POST /api/region_sales_acc_summary/pip/data schema - New endpoint with accessory data structure (similar to v1)
const postPipDataV31Schema = Joi.object({
  filters: Joi.object({
    region_code: Joi.array().items(Joi.string()).optional(),
    district_code: Joi.array().items(Joi.string()).optional(),
    dealer_code: Joi.array().items(Joi.string()).optional(),
    transaction_date: Joi.object({
      gte: Joi.string().optional().description('Start date (yyyy-MM-dd)'),
      lte: Joi.string().optional().description('End date (yyyy-MM-dd)')
    }).optional(),
    // Additional filters from v1 plus new v31 fields
    model_year: Joi.array().items(Joi.string()).optional(),
    model_code: Joi.array().items(Joi.string()).optional(),
    fleet_flag: Joi.array().items(Joi.boolean()).optional(),
    brand_code: Joi.array().items(Joi.string()).optional(),
    segment_code: Joi.array().items(Joi.string()).optional(),
    car_trk_indicator: Joi.array().items(Joi.string()).optional(),
    dealer_type: Joi.array().items(Joi.string()).optional(),
    team_lease_indicator: Joi.array().items(Joi.string()).optional(),
    transmissiontype_code: Joi.array().items(Joi.string()).optional(),
    series_name: Joi.array().items(Joi.string()).optional(),
    grade_code: Joi.array().items(Joi.string()).optional(),
    // New v31 filter fields
    drivetrain_code: Joi.array().items(Joi.string()).optional(),
    accessory_code: Joi.array().items(Joi.string()).optional(),
    fac_pio_indicator: Joi.array().items(Joi.string()).optional(),
    napc_bu_code: Joi.array().items(Joi.string()).optional(),
    sls_ccyymm: Joi.array().items(Joi.string()).optional().description('Filter by year-month in CCYYMM format (e.g., "202407")')
  }).optional(),
  inlinefilter: Joi.array().items(
    Joi.object({
      field: Joi.string().valid(
        'sales_availability_count', 'days_supply_count', 'retail_count', 'vpc_stock_count',
        'unbuilt_count', 'company_stock_count', 'dealer_stock_count', 'intransit_othervpc_count',
        'totalstock_count', 'other_vpc_count', 'postprocess_intransit_count', 'preprocess_intransit_vpc_count',
        'wholesale_count', 'hist_dealerstock_count', 'hist_tmsstock_count', 'hist_mfgstock_count',
        'hist_portstock_count', 'hist_intransitstock_count', 'region_code', 'district_code', 'dealer_code',
        'region_name', 'dealer_name'
      ).required(),
      condition: Joi.string().valid('>=', '<=', '=', '>', '<', 'contains').required(),
      value: Joi.alternatives().try(Joi.number(), Joi.string()).required()
    })
  ).optional().description('Inline filters to apply to aggregated data after retrieval'),
  sortfields: Joi.array().items(
    Joi.object({
      field: Joi.string().valid(
        'sales_availability_count', 'days_supply_count', 'retail_count', 'vpc_stock_count',
        'unbuilt_count', 'company_stock_count', 'dealer_stock_count', 'intransit_othervpc_count',
        'totalstock_count', 'other_vpc_count', 'postprocess_intransit_count', 'preprocess_intransit_vpc_count',
        'wholesale_count', 'hist_dealerstock_count', 'hist_tmsstock_count', 'hist_mfgstock_count',
        'hist_portstock_count', 'hist_intransitstock_count', 'distributor_code', 'distributor_name',
        'region_code', 'region_name', 'dealer_code', 'dealer_name'
      ).required(),
      order: Joi.string().valid('asc', 'desc').required()
    })
  ).optional().description('Fields to sort aggregated data by after retrieval'),
  pagination: Joi.object({
    page: Joi.number().integer().min(1).default(1),
    page_size: Joi.number().integer().min(1).max(3000).default(25)
  }).default({ page: 1, page_size: 10 }),
  index_type: Joi.string().valid('0', '1', '2', '3', '4', '5', '6', '7').default('currmth').description('Index type for date-based index selection')
});

// POST /api/region_sales_acc_summary/pip/data - Get PIP data using POST request with accessory index structure (similar to v1)
router.post('/api/region_sales_acc_summary/pip/data', validateRequest({ body: postPipDataV31Schema }), async (req, res, next) => {
  try {
    console.log('entered the v31 function');
    const indexPar = req.query.index_par;
    logIndexPar('post_pip_data_v31', indexPar);

    // Create a copy of filters to avoid modifying the original request
    const filters = req.body.filters ? { ...req.body.filters } : null;

    // Convert all filter field values to uppercase if they are strings
    if (filters) {
      Object.keys(filters).forEach(key => {
        if (Array.isArray(filters[key])) {
          // Convert array values to uppercase if they are strings
          filters[key] = filters[key].map(value =>
            typeof value === 'string' ? value.toUpperCase() : value
          );
        } else if (typeof filters[key] === 'string') {
          // Convert single string values to uppercase
          filters[key] = filters[key].toUpperCase();
        }
        // Note: transaction_date object with gte/lte properties is left unchanged as dates should not be uppercased
      });
    }

    console.log('v31 filters:', JSON.stringify(filters));

    // Determine which index to use based on index_type
    const indexType = req.body.index_type;
    let indexName;
    const currentDate = new Date();
    const yearString = currentDate.getFullYear().toString();

    if (indexType == '0' || indexType == '1' || indexType == '2' || indexType == '3' || indexType == '4' || indexType == '5') {
      indexName = [`${ACCESSORY_INDEX}-${yearString}`];
    } else if (indexType == '6') {
      const previousYearString = (currentDate.getFullYear() - 1).toString();
      indexName = [`${ACCESSORY_INDEX}-${previousYearString}`];
    } else {
      if (filters && filters.sls_ccyymm && filters.sls_ccyymm.length > 0) {
        // Extract years from CCYYMM format (first 4 digits)
        const years = filters.sls_ccyymm.map(val => {
          const ccyymm = val.toString().padStart(6, '0');
          return parseInt(ccyymm.substring(0, 4));
        });

        const minYear = Math.min(...years);
        const maxYear = Math.max(...years);

        console.log(`V31 Min year: ${minYear}, Max year: ${maxYear}`);
        if (minYear === maxYear) {
          indexName = [`${ACCESSORY_INDEX}-${minYear}`];
        } else {
          indexName = [`${ACCESSORY_INDEX}-${minYear}`, `${ACCESSORY_INDEX}-${maxYear}`];
        }
      } else {
        // Default to current year index
        indexName = [`${ACCESSORY_INDEX}-${yearString}`];
      }
    }

    console.log('v31 index name:', indexName);

    // Execute query using the new v31 service method
    const initialResult = await pipService.executePaginatedQueryV31(
      filters || null,
      { page: 1, page_size: 10000 }, // Get a large page to apply filtering and sorting first
      indexName
    );

    if (!initialResult.success) {
      return next(new Error(initialResult.error));
    }

    // Get aggregated data to apply inline filtering and sorting
    let aggregatedData = initialResult.data || [];

    // Apply inline filtering if provided
    if (req.body.inlinefilter && Array.isArray(req.body.inlinefilter) && req.body.inlinefilter.length > 0) {
      console.log(`Applying ${req.body.inlinefilter.length} inline filters to v31 aggregated data`);

      aggregatedData = aggregatedData.filter(item => {
        return req.body.inlinefilter.every(filter => {
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
              // Full text search - convert both to string and check if fieldValue contains the search term
              const fieldStr = String(fieldValue).toLowerCase();
              const searchStr = String(filter.value).toLowerCase();
              return fieldStr.includes(searchStr);
            default:
              return true;
          }
        });
      });

      console.log(`After v31 inline filtering, ${aggregatedData.length} items remain`);
    }

    // Apply sorting if provided
    if (req.body.sortfields && Array.isArray(req.body.sortfields) && req.body.sortfields.length > 0) {
      console.log(`Applying v31 sorting by ${req.body.sortfields.length} fields`);

      aggregatedData.sort((a, b) => {
        for (const sort of req.body.sortfields) {
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

    // Transform data into hierarchical structure
    const transformedData = transformToHierarchicalStructure(aggregatedData);

    // Apply pagination at the region level
    const pagination = req.body.pagination || { page: 1, page_size: 10 };
    const totalRegions = transformedData.regionSummary.regions.length;
    const startIndex = (pagination.page - 1) * pagination.page_size;
    const endIndex = startIndex + pagination.page_size;

    // Get paginated regions
    const paginatedRegions = transformedData.regionSummary.regions.slice(startIndex, endIndex);

    // Recalculate totals for paginated regions only
    const numericFields = [
      'sales_availability_count', 'days_supply_count', 'retail_count', 'vpc_stock_count',
      'unbuilt_count', 'company_stock_count', 'dealer_stock_count', 'intransit_othervpc_count',
      'totalstock_count', 'other_vpc_count', 'postprocess_intransit_count', 'preprocess_intransit_vpc_count',
      'wholesale_count', 'hist_dealerstock_count', 'hist_tmsstock_count', 'hist_mfgstock_count',
      'hist_portstock_count', 'hist_intransitstock_count'
    ];

    const paginatedTotals = {};
    numericFields.forEach(field => {
      paginatedTotals[field] = 0;
    });

    paginatedRegions.forEach(region => {
      numericFields.forEach(field => {
        paginatedTotals[field] += (region[field] || 0);
      });
    });

    // Create pagination info
    const updatedPaginationInfo = {
      current_page: pagination.page,
      page_size: paginatedRegions.length,
      total_pages: Math.ceil(totalRegions / pagination.page_size),
      has_next_page: endIndex < totalRegions,
      has_previous_page: startIndex > 0,
      total_regions: totalRegions
    };

    // Prepare response with paginated regions
    const result = {
      data: {
        regionSummary: {
          count: paginatedRegions.length,
          regions: paginatedRegions,
          totals: paginatedTotals
        }
      },
      pagination: updatedPaginationInfo
    };

    // Calculate sales_to_availability for paginated totals
    const paginatedRetailCount = paginatedTotals.retail_count || 0;
    const paginatedDealerStockCount = paginatedTotals.dealer_stock_count || 0;
    const paginatedDenominator = paginatedRetailCount + paginatedDealerStockCount;
    paginatedTotals.sales_to_availability = paginatedDenominator > 0 ? parseFloat((paginatedRetailCount / paginatedDenominator).toFixed(4)) : 0;

    console.log(`v31 pagination: Total regions: ${totalRegions}, Page: ${pagination.page}, Regions in page: ${paginatedRegions.length}`);
    return res.json(result);
  } catch (error) {
    console.error('Error in POST /api/v31/pip/data:', error);
    next(error);
  }
});

// POST /api/region_sales_color_summary/pip/data schema - New endpoint with sales inventory data structure including color filters
const postPipDataV32Schema = Joi.object({
  filters: Joi.object({
    region_code: Joi.array().items(Joi.string()).optional(),
    district_code: Joi.array().items(Joi.string()).optional(),
    dealer_code: Joi.array().items(Joi.string()).optional(),
    transaction_date: Joi.object({
      gte: Joi.string().optional().description('Start date (yyyy-MM-dd)'),
      lte: Joi.string().optional().description('End date (yyyy-MM-dd)')
    }).optional(),
    // Additional filters from v31 plus new v32 color fields
    model_year: Joi.array().items(Joi.string()).optional(),
    model_code: Joi.array().items(Joi.string()).optional(),
    fleet_flag: Joi.array().items(Joi.boolean()).optional(),
    brand_code: Joi.array().items(Joi.string()).optional(),
    segment_code: Joi.array().items(Joi.string()).optional(),
    car_trk_indicator: Joi.array().items(Joi.string()).optional(),
    dealer_type: Joi.array().items(Joi.string()).optional(),
    team_lease_indicator: Joi.array().items(Joi.string()).optional(),
    transmissiontype_code: Joi.array().items(Joi.string()).optional(),
    series_name: Joi.array().items(Joi.string()).optional(),
    grade_code: Joi.array().items(Joi.string()).optional(),
    drivetrain_code: Joi.array().items(Joi.string()).optional(),
    napc_bu_code: Joi.array().items(Joi.string()).optional(),
    sls_ccyymm: Joi.array().items(Joi.string()).optional().description('Filter by year-month in CCYYMM format (e.g., "202407")'),
    // New v32 color filter fields
    exterior_color_code: Joi.array().items(Joi.string()).optional(),
    interior_color_code: Joi.array().items(Joi.string()).optional()
  }).optional(),
  inlinefilter: Joi.array().items(
    Joi.object({
      field: Joi.string().valid(
        'sales_availability_count', 'days_supply_count', 'retail_count', 'vpc_stock_count',
        'unbuilt_count', 'company_stock_count', 'dealer_stock_count', 'intransit_othervpc_count',
        'totalstock_count', 'other_vpc_count', 'postprocess_intransit_count', 'preprocess_intransit_vpc_count',
        'wholesale_count', 'hist_dealerstock_count', 'hist_tmsstock_count', 'hist_mfgstock_count',
        'hist_portstock_count', 'hist_intransitstock_count', 'region_code', 'district_code', 'dealer_code',
        'region_name', 'dealer_name'
      ).required(),
      condition: Joi.string().valid('>=', '<=', '=', '>', '<', 'contains').required(),
      value: Joi.alternatives().try(Joi.number(), Joi.string()).required()
    })
  ).optional().description('Inline filters to apply to aggregated data after retrieval'),
  sortfields: Joi.array().items(
    Joi.object({
      field: Joi.string().valid(
        'sales_availability_count', 'days_supply_count', 'retail_count', 'vpc_stock_count',
        'unbuilt_count', 'company_stock_count', 'dealer_stock_count', 'intransit_othervpc_count',
        'totalstock_count', 'other_vpc_count', 'postprocess_intransit_count', 'preprocess_intransit_vpc_count',
        'wholesale_count', 'hist_dealerstock_count', 'hist_tmsstock_count', 'hist_mfgstock_count',
        'hist_portstock_count', 'hist_intransitstock_count', 'distributor_code', 'distributor_name',
        'region_code', 'region_name', 'dealer_code', 'dealer_name', 'district_code'
      ).required(),
      order: Joi.string().valid('asc', 'desc').required()
    })
  ).optional().description('Fields to sort aggregated data by after retrieval'),
  pagination: Joi.object({
    page: Joi.number().integer().min(1).default(1),
    page_size: Joi.number().integer().min(1).max(3000).default(25)
  }).default({ page: 1, page_size: 10 }),
  index_type: Joi.string().valid('0', '1', '2', '3', '4', '5', '6', '7').default('currmth').description('Index type for date-based index selection')
});

// POST /summary/byRegion-Color schema - Enhanced endpoint with comprehensive filtering and sorting
const postPipDataV33Schema = Joi.object({
  filters: Joi.object({
    // Core location filters
    region_code: Joi.array().items(Joi.string()).optional(),
    region_name: Joi.array().items(Joi.string()).optional(),
    district_code: Joi.array().items(Joi.string()).optional(),
    district_name: Joi.array().items(Joi.string()).optional(),
    dealer_code: Joi.array().items(Joi.string()).optional(),
    dealer_name: Joi.array().items(Joi.string()).optional(),
    dealer_group_name: Joi.array().items(Joi.string()).optional(),
    dealer_type: Joi.array().items(Joi.string()).optional(),

    // Distributor filters
    distributor_code: Joi.array().items(Joi.string()).optional(),

    // Date filters
    transaction_date: Joi.object({
      gte: Joi.string().optional().description('Start date (yyyy-MM-dd)'),
      lte: Joi.string().optional().description('End date (yyyy-MM-dd)')
    }).optional(),
    sls_ccyymm: Joi.array().items(Joi.string()).optional().description('Filter by year-month in CCYYMM format (e.g., "202407")'),

    // Vehicle filters
    vehicle_assignment_indicator: Joi.array().items(Joi.string()).optional(),
    model_year: Joi.array().items(Joi.string()).optional(),
    model_code: Joi.array().items(Joi.string()).optional(),
    fleet_flag: Joi.array().items(Joi.boolean()).optional(),
    fd_fleet_flag: Joi.array().items(Joi.boolean()).optional(),
    fd_fleet_description: Joi.array().items(Joi.string()).optional(),

    // Brand and segment filters
    brand_code: Joi.array().items(Joi.string()).optional(),
    segment_code: Joi.array().items(Joi.string()).optional(),
    subsegment_code: Joi.array().items(Joi.string()).optional(),

    // Vehicle characteristics
    car_trk_indicator: Joi.array().items(Joi.string()).optional(),
    team_lease_indicator: Joi.array().items(Joi.boolean()).optional(),
    team_member_lease_sale_type: Joi.array().items(Joi.string()).optional(),
    nap_cbu_code: Joi.array().items(Joi.string()).optional(),

    // Series and grade filters
    series_name: Joi.array().items(Joi.string()).optional(),
    series_display_order: Joi.array().items(Joi.string()).optional(),
    grade_code: Joi.array().items(Joi.string()).optional(),

    // Technical specifications
    transmissiontype_code: Joi.array().items(Joi.string()).optional(),
    drivetrain_code: Joi.array().items(Joi.string()).optional(),
    fueltype_code: Joi.array().items(Joi.string()).optional(),
    enginefueltype_code: Joi.array().items(Joi.string()).optional(),

    // Color filters
    exterior_color_code: Joi.array().items(Joi.string()).optional(),
    exterior_color_desc: Joi.array().items(Joi.string()).optional(),
    interior_color_code: Joi.array().items(Joi.string()).optional(),
    interior_trim_color_desc: Joi.array().items(Joi.string()).optional()
  }).optional(),

  inlinefilter: Joi.array().items(
    Joi.object({
      field: Joi.string().valid(
        // Text fields for contains filtering
        'region_code', 'region_name', 'district_code', 'district_name', 'dealer_code', 'dealer_name',
        'vehicle_assignment_indicator', 'brand_code', 'objective_available_indicator',
        // Numeric fields for comparison filtering
        'retail_count', 'wholesale_count', 'distributor_count', 'retail_objective_count',
        'wholesale_objective_count', 'dealer_retail_obj', 'series_retail_ytd_obj', 'series_wholesale_ytd_obj',
        'region_retail_ytd_obj', 'region_wholesale_ytd_obj', 'retail_objective_percentage',
        'wholesale_objective_percentage', 'sales_availability_count', 'days_supply_count',
        'vpc_stock_count', 'unbuilt_count', 'company_stock_count', 'dealer_stock_count',
        'intransit_othervpc_count', 'totalstock_count', 'other_vpc_count', 'postprocess_intransit_count',
        'preprocess_intransit_vpc_count', 'hist_dealerstock_count', 'hist_tmsstock_count',
        'hist_mfgstock_count', 'hist_portstock_count', 'hist_intransitstock_count', 'sales_to_availability'
      ).required(),
      condition: Joi.string().valid('>=', '<=', '=', '>', '<', 'contains').required(),
      value: Joi.alternatives().try(Joi.number(), Joi.string(), Joi.array().items(Joi.string())).required()
    })
  ).optional().description('Inline filters to apply to aggregated data after retrieval'),

  sortfields: Joi.array().items(
    Joi.object({
      field: Joi.string().valid(
        'region_code', 'region_name', 'district_code', 'district_name', 'dealer_code', 'dealer_name',
        'vehicle_assignment_indicator', 'brand_code', 'objective_available_indicator', 'retail_count',
        'wholesale_count', 'distributor_count', 'retail_objective_count', 'wholesale_objective_count',
        'dealer_retail_obj', 'series_retail_ytd_obj', 'series_wholesale_ytd_obj', 'region_retail_ytd_obj',
        'region_wholesale_ytd_obj', 'retail_objective_percentage', 'wholesale_objective_percentage',
        'sales_availability_count', 'days_supply_count', 'vpc_stock_count', 'unbuilt_count',
        'company_stock_count', 'dealer_stock_count', 'intransit_othervpc_count', 'totalstock_count',
        'other_vpc_count', 'postprocess_intransit_count', 'preprocess_intransit_vpc_count',
        'hist_dealerstock_count', 'hist_tmsstock_count', 'hist_mfgstock_count', 'hist_portstock_count',
        'hist_intransitstock_count', 'sales_to_availability'
      ).required(),
      order: Joi.string().valid('asc', 'desc').required()
    })
  ).optional().description('Fields to sort aggregated data by after retrieval'),

  pagination: Joi.object({
    page: Joi.number().integer().min(1).default(1),
    page_size: Joi.number().integer().min(1).max(3000).default(25)
  }).default({ page: 1, page_size: 10 }),

  index_type: Joi.string().valid('0', '1', '2', '3', '4', '5', '6', '7').default('0').description('Index type for query selection logic')
});

// POST /api/region_sales_acc_summary/pip/data - Get PIP data using POST request with sales inventory index structure including color filters
router.post('/api/region_sales_color_summary/pip/data', validateRequest({ body: postPipDataV32Schema }), async (req, res, next) => {
  try {
    console.log('entered the v32 function');
    const indexPar = req.query.index_par;
    logIndexPar('post_pip_data_v32', indexPar);

    // Create a copy of filters to avoid modifying the original request
    const filters = req.body.filters ? { ...req.body.filters } : null;

    // Convert all filter field values to uppercase if they are strings
    if (filters) {
      Object.keys(filters).forEach(key => {
        if (Array.isArray(filters[key])) {
          // Convert array values to uppercase if they are strings
          filters[key] = filters[key].map(value =>
            typeof value === 'string' ? value.toUpperCase() : value
          );
        } else if (typeof filters[key] === 'string') {
          // Convert single string values to uppercase
          filters[key] = filters[key].toUpperCase();
        }
        // Note: transaction_date object with gte/lte properties is left unchanged as dates should not be uppercased
      });
    }

    console.log('v32 filters:', JSON.stringify(filters));

    // Determine which index to use based on index_type
    const indexType = req.body.index_type;
    let indexName;
    const currentDate = new Date();
    const yearString = currentDate.getFullYear().toString();

    if (indexType == '0' || indexType == '1' || indexType == '2' || indexType == '3' || indexType == '4' || indexType == '5') {
      indexName = [`${SALES_INV_INDEX}-${yearString}`];
    } else if (indexType == '6') {
      const previousYearString = (currentDate.getFullYear() - 1).toString();
      indexName = [`${SALES_INV_INDEX}-${previousYearString}`];
    } else {
      if (filters && filters.sls_ccyymm && filters.sls_ccyymm.length > 0) {
        // Extract years from CCYYMM format (first 4 digits)
        const years = filters.sls_ccyymm.map(val => {
          const ccyymm = val.toString().padStart(6, '0');
          return parseInt(ccyymm.substring(0, 4));
        });

        const minYear = Math.min(...years);
        const maxYear = Math.max(...years);

        console.log(`V32 Min year: ${minYear}, Max year: ${maxYear}`);
        if (minYear === maxYear) {
          indexName = [`${SALES_INV_INDEX}-${minYear}`];
        } else {
          indexName = [`${SALES_INV_INDEX}-${minYear}`, `${SALES_INV_INDEX}-${maxYear}`];
        }
      } else {
        // Default to current year index
        indexName = [`${SALES_INV_INDEX}-${yearString}`];
      }
    }

    console.log('v32 index name:', indexName);

    // Execute query using the new v32 service method
    const initialResult = await pipService.executePaginatedQueryV32(
      filters || null,
      { page: 1, page_size: 10000 }, // Get a large page to apply filtering and sorting first
      indexName
    );

    if (!initialResult.success) {
      return next(new Error(initialResult.error));
    }

    // Get aggregated data to apply inline filtering and sorting
    let aggregatedData = initialResult.data || [];

    // Apply inline filtering if provided
    if (req.body.inlinefilter && Array.isArray(req.body.inlinefilter) && req.body.inlinefilter.length > 0) {
      console.log(`Applying ${req.body.inlinefilter.length} inline filters to v32 aggregated data`);

      aggregatedData = aggregatedData.filter(item => {
        return req.body.inlinefilter.every(filter => {
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
              // Full text search - convert both to string and check if fieldValue contains the search term
              const fieldStr = String(fieldValue).toLowerCase();
              const searchStr = String(filter.value).toLowerCase();
              return fieldStr.includes(searchStr);
            default:
              return true;
          }
        });
      });

      console.log(`After v32 inline filtering, ${aggregatedData.length} items remain`);
    }

    // Apply sorting if provided
    if (req.body.sortfields && Array.isArray(req.body.sortfields) && req.body.sortfields.length > 0) {
      console.log(`Applying v32 sorting by ${req.body.sortfields.length} fields`);

      aggregatedData.sort((a, b) => {
        for (const sort of req.body.sortfields) {
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

    // Transform data into hierarchical structure
    const transformedData = transformToHierarchicalStructure(aggregatedData);

    // Apply pagination at the region level
    const pagination = req.body.pagination || { page: 1, page_size: 10 };
    const totalRegions = transformedData.regionSummary.regions.length;
    const startIndex = (pagination.page - 1) * pagination.page_size;
    const endIndex = startIndex + pagination.page_size;

    // Get paginated regions
    const paginatedRegions = transformedData.regionSummary.regions.slice(startIndex, endIndex);

    // Recalculate totals for paginated regions only
    const numericFields = [
      'sales_availability_count', 'days_supply_count', 'retail_count', 'vpc_stock_count',
      'unbuilt_count', 'company_stock_count', 'dealer_stock_count', 'intransit_othervpc_count',
      'totalstock_count', 'other_vpc_count', 'postprocess_intransit_count', 'preprocess_intransit_vpc_count',
      'wholesale_count', 'hist_dealerstock_count', 'hist_tmsstock_count', 'hist_mfgstock_count',
      'hist_portstock_count', 'hist_intransitstock_count'
    ];

    const paginatedTotals = {};
    numericFields.forEach(field => {
      paginatedTotals[field] = 0;
    });

    paginatedRegions.forEach(region => {
      numericFields.forEach(field => {
        paginatedTotals[field] += (region[field] || 0);
      });
    });

    // Create pagination info
    const updatedPaginationInfo = {
      current_page: pagination.page,
      page_size: paginatedRegions.length,
      total_pages: Math.ceil(totalRegions / pagination.page_size),
      has_next_page: endIndex < totalRegions,
      has_previous_page: startIndex > 0,
      total_regions: totalRegions
    };

    // Prepare response with paginated regions
    const result = {
      data: {
        regionSummary: {
          count: paginatedRegions.length,
          regions: paginatedRegions,
          totals: paginatedTotals
        }
      },
      pagination: updatedPaginationInfo
    };

    // Calculate sales_to_availability for paginated totals
    const paginatedRetailCount = paginatedTotals.retail_count || 0;
    const paginatedDealerStockCount = paginatedTotals.dealer_stock_count || 0;
    const paginatedDenominator = paginatedRetailCount + paginatedDealerStockCount;
    paginatedTotals.sales_to_availability = paginatedDenominator > 0 ? parseFloat((paginatedRetailCount / paginatedDenominator).toFixed(4)) : 0;

    console.log(`v32 pagination: Total regions: ${totalRegions}, Page: ${pagination.page}, Regions in page: ${paginatedRegions.length}`);
    return res.json(result);
  } catch (error) {
    console.error('Error in POST /api/v32/pip/data:', error);
    next(error);
  }
});

// POST /summary/byRegion-Color - Enhanced endpoint with comprehensive filtering and sorting
router.post('/summary/byRegion-Color', validateRequest({ body: postPipDataV33Schema }), async (req, res, next) => {
  try {
    console.log('entered the v33 enhanced function');

    // Helper function to convert string boolean values to actual booleans
    const convertToBoolean = (value) => {
      if (typeof value === 'boolean') return value;
      if (typeof value === 'string') return value.toUpperCase() === 'TRUE';
      return false;
    };

    const indexPar = req.query.index_par;
    logIndexPar('post_pip_data_v33', indexPar);

    // Get request parameters
    const filters = req.body.filters || null;
    const inlineFilters = req.body.inlinefilter || [];
    const sortFields = req.body.sortfields || [];
    const pagination = req.body.pagination || { page: 1, page_size: 10 };
    const indexType = req.body.index_type || '0';

    // Preprocess inline filters to convert boolean values to strings for OpenSearch compatibility
    const processedInlineFilters = inlineFilters.map(filter => {
      if (filter.field === 'objective_available_indicator' || filter.field === 'vehicle_assignment_indicator') {
        // Convert boolean values to string format expected by OpenSearch
        if (typeof filter.value === 'boolean') {
          return {
            ...filter,
            value: filter.value ? true : false
          };
        }
        // If it's already a string, ensure it's uppercase
        if (typeof filter.value === 'string') {
          return {
            ...filter,
            value: filter.value.toUpperCase()
          };
        }
      }
      return filter;
    });

    console.log('v33 filters:', JSON.stringify(filters));
    console.log('v33 inline filters:', JSON.stringify(inlineFilters));
    console.log('v33 processed inline filters:', JSON.stringify(processedInlineFilters));
    console.log('v33 sort fields:', JSON.stringify(sortFields));
    console.log('v33 index type:', indexType);

    // Determine which index to use - for index types 0, 3, 5 use the color summary index
    let indexName;
    const currentDate = new Date();
    const yearString = currentDate.getFullYear().toString();

    if (['0', '3', '5'].includes(indexType)) {
      // Use the color summary index for these types
      indexName = [`pipe-rgn-dlr-dist-sale-color-current-summary-${yearString}`];
    } else if (indexType === '6') {
      const previousYearString = (currentDate.getFullYear() - 1).toString();
      indexName = [`pipe-rgn-dlr-dist-sale-color-current-summary-${previousYearString}`];
    } else {
      if (filters && filters.sls_ccyymm && filters.sls_ccyymm.length > 0) {
        // Extract years from CCYYMM format (first 4 digits)
        const years = filters.sls_ccyymm.map(val => {
          const ccyymm = val.toString().padStart(6, '0');
          return parseInt(ccyymm.substring(0, 4));
        });

        const minYear = Math.min(...years);
        const maxYear = Math.max(...years);

        console.log(`V33 Min year: ${minYear}, Max year: ${maxYear}`);
        if (minYear === maxYear) {
          indexName = [`pipe-rgn-dlr-dist-sale-color-current-summary-${minYear}`];
        } else {
          indexName = [`pipe-rgn-dlr-dist-sale-color-current-summary-${minYear}`, `pipe-rgn-dlr-dist-sale-color-current-summary-${maxYear}`];
        }
      } else {
        // Default to current year index
        indexName = [`pipe-rgn-dlr-dist-sale-color-current-summary-${yearString}`];
      }
    }

    console.log('v33 index name:', indexName);

    // Execute enhanced query using the new v33 service method with OpenSearch-based filtering and sorting
    const initialResult = await pipService.executePaginatedQueryV33(
      filters,
      { page: 1, page_size: 50000 }, // Large page size for comprehensive results
      indexName,
      indexType,
      processedInlineFilters, // Pass processed inline filters to OpenSearch
      sortFields     // Pass sort fields to OpenSearch
    );

    if (!initialResult.success) {
      return next(new Error(initialResult.error));
    }

    // Get aggregated data (already filtered and sorted by OpenSearch)
    let aggregatedData = initialResult.data || [];
    console.log(`V33 Data count after OpenSearch processing: ${aggregatedData.length}`);

    // Transform data into enhanced hierarchical structure first
    const transformedData = pipService._transformToHierarchicalStructureV33(aggregatedData, pagination);

    // Apply pagination at the region level
    const totalRegions = transformedData.regionSummary.regions.length;
    const startIndex = (pagination.page - 1) * pagination.page_size;
    const endIndex = startIndex + pagination.page_size;

    // Get paginated regions
    const paginatedRegions = transformedData.regionSummary.regions.slice(startIndex, endIndex);

    // Recalculate totals for paginated regions only
    const numericFields = [
      'sales_availability_count', 'days_supply_count', 'retail_count', 'vpc_stock_count',
      'unbuilt_count', 'company_stock_count', 'dealer_stock_count', 'intransit_othervpc_count',
      'totalstock_count', 'other_vpc_count', 'postprocess_intransit_count', 'preprocess_intransit_vpc_count',
      'wholesale_count', 'hist_dealerstock_count', 'hist_tmsstock_count', 'hist_mfgstock_count',
      'hist_portstock_count', 'hist_intransitstock_count', 'distributor_count', 'retail_objective_count',
      'wholesale_objective_count', 'dealer_retail_obj', 'series_retail_ytd_obj', 'series_wholesale_ytd_obj',
      'region_retail_ytd_obj', 'region_wholesale_ytd_obj'
    ];

    const paginatedTotals = {};
    numericFields.forEach(field => {
      paginatedTotals[field] = 0;
    });

    paginatedRegions.forEach(region => {
      numericFields.forEach(field => {
        paginatedTotals[field] += (region[field] || 0);
      });
    });

    // Calculate paginated totals percentages
    const paginatedRetailCount = paginatedTotals.retail_count || 0;
    const paginatedRetailObjective = paginatedTotals.retail_objective_count || 0;
    const paginatedWholesaleCount = paginatedTotals.wholesale_count || 0;
    const paginatedWholesaleObjective = paginatedTotals.wholesale_objective_count || 0;
    const paginatedDealerStockCount = paginatedTotals.dealer_stock_count || 0;

    paginatedTotals.retail_objective_percentage = paginatedRetailObjective > 0
      ? parseFloat(((paginatedRetailCount / paginatedRetailObjective) * 100).toFixed(2))
      : 0;
    paginatedTotals.wholesale_objective_percentage = paginatedWholesaleObjective > 0
      ? parseFloat(((paginatedWholesaleCount / paginatedWholesaleObjective) * 100).toFixed(2))
      : 0;

    // Always set sales_to_availability to 0 as per requirement
    paginatedTotals.sales_to_availability = 0;

    // Filter response to include only required fields
    const filterResponseFields = (obj, level) => {
      // Base fields that are common to all levels
      const commonFields = ['sales_availability_count', 'days_supply_count', 'retail_count', 'wholesale_count',
        'distributor_count', 'vpc_stock_count', 'unbuilt_count', 'company_stock_count',
        'dealer_stock_count', 'intransit_othervpc_count', 'totalstock_count', 'other_vpc_count',
        'postprocess_intransit_count', 'preprocess_intransit_vpc_count', 'hist_dealerstock_count',
        'hist_tmsstock_count', 'hist_mfgstock_count', 'hist_portstock_count',
        'hist_intransitstock_count', 'sales_to_availability'];

      // Objective fields that should only exist at region level
      const regionOnlyFields = ['retail_objective_count', 'retail_objective_percentage',
        'wholesale_objective_count', 'wholesale_objective_percentage'];

      const filtered = {};

      if (level === 'region') {
        filtered.region_code = obj.region_code;
        filtered.region_name = obj.region_name;
        filtered.brand_code = obj.brand_code;
        filtered.objective_available_indicator = obj.objective_available_indicator;
        // Note: region_display_order is excluded from response as it's only used for sorting

        // Add all fields including objective fields for regions
        [...commonFields, ...regionOnlyFields].forEach(field => {
          filtered[field] = obj[field] || 0;
        });
      } else if (level === 'district') {
        filtered.district_code = obj.district_code;
        filtered.district_name = obj.district_name;
        filtered.brand_code = obj.brand_code;
        filtered.vehicle_assignment_indicator = obj.vehicle_assignment_indicator;

        // Add only common fields (exclude objective fields for districts)
        commonFields.forEach(field => {
          filtered[field] = obj[field] || 0;
        });
      } else if (level === 'dealer') {
        filtered.dealer_code = obj.dealer_code;
        filtered.dealer_name = obj.dealer_name;
        filtered.brand_code = obj.brand_code;
        filtered.vehicle_assignment_indicator = obj.vehicle_assignment_indicator;

        // Add only common fields (exclude objective fields for dealers)
        commonFields.forEach(field => {
          filtered[field] = obj[field] || 0;
        });
      }

      return filtered;
    };

    // Filter paginated regions
    const filteredRegions = paginatedRegions.map(region => {
      const filteredRegion = filterResponseFields(region, 'region');
      filteredRegion.districts = region.districts.map(district => {
        const filteredDistrict = filterResponseFields(district, 'district');
        filteredDistrict.dealers = district.dealers.map(dealer =>
          filterResponseFields(dealer, 'dealer')
        );
        return filteredDistrict;
      });
      return filteredRegion;
    });

    // Filter totals to include only required fields
    const filteredTotals = {};
    const totalFields = ['sales_availability_count', 'days_supply_count', 'retail_count', 'wholesale_count',
      'distributor_count', 'retail_objective_count', 'retail_objective_percentage',
      'wholesale_objective_count', 'wholesale_objective_percentage', 'vpc_stock_count',
      'unbuilt_count', 'company_stock_count', 'dealer_stock_count', 'intransit_othervpc_count',
      'totalstock_count', 'other_vpc_count', 'postprocess_intransit_count',
      'preprocess_intransit_vpc_count', 'hist_dealerstock_count', 'hist_tmsstock_count',
      'hist_mfgstock_count', 'hist_portstock_count', 'hist_intransitstock_count', 'sales_to_availability'];

    totalFields.forEach(field => {
      filteredTotals[field] = paginatedTotals[field] || 0;
    });

    // Create pagination info without total_regions
    const totalPages = Math.ceil(totalRegions / pagination.page_size);
    const updatedPaginationInfo = {
      current_page: pagination.page,
      page_size: filteredRegions.length,
      total_pages: totalPages,
      has_next_page: endIndex < totalRegions,
      has_previous_page: startIndex > 0
    };

    // Calculate count as the total number of regions before pagination
    const correctCount = totalRegions;

    // Prepare enhanced response with filtered regions
    const result = {
      data: {
        regionSummary: {
          count: correctCount,
          regions: filteredRegions,
          totals: filteredTotals
        }
      },
      pagination: updatedPaginationInfo
    };

    // Convert boolean fields in the filtered regions
    result.data.regionSummary.regions.forEach(region => {
      if (region.objective_available_indicator !== undefined) {
        region.objective_available_indicator = convertToBoolean(region.objective_available_indicator);
      }

      region.districts.forEach(district => {
        if (district.vehicle_assignment_indicator !== undefined) {
          district.vehicle_assignment_indicator = convertToBoolean(district.vehicle_assignment_indicator);
        }

        district.dealers.forEach(dealer => {
          if (dealer.vehicle_assignment_indicator !== undefined) {
            dealer.vehicle_assignment_indicator = convertToBoolean(dealer.vehicle_assignment_indicator);
          }
        });
      });
    });

    console.log(`V33 pagination: Total regions: ${totalRegions}, Page: ${pagination.page}, Regions in page: ${paginatedRegions.length}`);
    return res.json(result);
  } catch (error) {
    console.error('Error in POST /summary/byRegion-Color:', error);
    next(error);
  }
});

// POST /summary/byRegion-Accessory schema - Enhanced endpoint with accessory filtering and sorting
const postPipDataV34Schema = Joi.object({
  filters: Joi.object({
    // Core location filters
    region_code: Joi.array().items(Joi.string()).optional(),
    region_name: Joi.array().items(Joi.string()).optional(),
    district_code: Joi.array().items(Joi.string()).optional(),
    district_name: Joi.array().items(Joi.string()).optional(),
    dealer_code: Joi.array().items(Joi.string()).optional(),
    dealer_name: Joi.array().items(Joi.string()).optional(),
    dealer_group_name: Joi.array().items(Joi.string()).optional(),
    dealer_type: Joi.array().items(Joi.string()).optional(),

    // Distributor filters
    distributor_code: Joi.array().items(Joi.string()).optional(),

    // Date filters
    transaction_date: Joi.object({
      gte: Joi.string().optional().description('Start date (yyyy-MM-dd)'),
      lte: Joi.string().optional().description('End date (yyyy-MM-dd)')
    }).optional(),
    sls_ccyymm: Joi.array().items(Joi.string()).optional().description('Filter by year-month in CCYYMM format (e.g., "202407")'),

    // Vehicle filters
    vehicle_assignment_indicator: Joi.array().items(Joi.boolean()).optional(),
    objective_available_indicator: Joi.array().items(Joi.boolean()).optional(),
    model_year: Joi.array().items(Joi.string()).optional(),
    model_code: Joi.array().items(Joi.string()).optional(),
    fleet_flag: Joi.array().items(Joi.boolean()).optional(),
    fd_fleet_flag: Joi.array().items(Joi.boolean()).optional(),
    fd_fleet_description: Joi.array().items(Joi.string()).optional(),

    // Brand and segment filters
    brand_code: Joi.array().items(Joi.string()).optional(),
    segment_code: Joi.array().items(Joi.string()).optional(),
    subsegment_code: Joi.array().items(Joi.string()).optional(),

    // Vehicle characteristics
    car_trk_indicator: Joi.array().items(Joi.string()).optional(),
    team_lease_indicator: Joi.array().items(Joi.boolean()).optional(),
    team_member_lease_sale_type: Joi.array().items(Joi.string()).optional(),
    nap_cbu_code: Joi.array().items(Joi.string()).optional(),

    // Series and grade filters
    series_name: Joi.array().items(Joi.string()).optional(),
    series_display_order: Joi.array().items(Joi.string()).optional(),
    grade_code: Joi.array().items(Joi.string()).optional(),

    // Technical specifications
    transmissiontype_code: Joi.array().items(Joi.string()).optional(),
    drivetrain_code: Joi.array().items(Joi.string()).optional(),
    fueltype_code: Joi.array().items(Joi.string()).optional(),
    enginefueltype_code: Joi.array().items(Joi.string()).optional(),

    // Accessory filters (replacing color filters)
    fio_ppo_indicator: Joi.array().items(Joi.boolean()).optional(),
    accessory_code: Joi.array().items(Joi.string()).optional(),
    accessory_desc: Joi.array().items(Joi.string()).optional()
  }).optional(),

  inlinefilter: Joi.array().items(
    Joi.object({
      field: Joi.string().valid(
        // Text fields for contains filtering
        'region_code', 'region_name', 'district_code', 'district_name', 'dealer_code', 'dealer_name',
        'vehicle_assignment_indicator', 'brand_code', 'objective_available_indicator',
        // Numeric fields for comparison filtering
        'retail_count', 'wholesale_count', 'distributor_count', 'retail_objective_count',
        'wholesale_objective_count', 'dealer_retail_obj', 'series_retail_ytd_obj', 'series_wholesale_ytd_obj',
        'region_retail_ytd_obj', 'region_wholesale_ytd_obj', 'retail_objective_percentage',
        'wholesale_objective_percentage', 'sales_availability_count', 'days_supply_count',
        'vpc_stock_count', 'unbuilt_count', 'company_stock_count', 'dealer_stock_count',
        'intransit_othervpc_count', 'totalstock_count', 'other_vpc_count', 'postprocess_intransit_count',
        'preprocess_intransit_vpc_count', 'hist_dealerstock_count', 'hist_tmsstock_count',
        'hist_mfgstock_count', 'hist_portstock_count', 'hist_intransitstock_count', 'sales_to_availability'
      ).required(),
      condition: Joi.string().valid('>=', '<=', '=', '>', '<', 'contains').required(),
      value: Joi.alternatives().try(Joi.number(), Joi.string(), Joi.array().items(Joi.string())).required()
    })
  ).optional().description('Inline filters to apply to aggregated data after retrieval'),

  sortfields: Joi.array().items(
    Joi.object({
      field: Joi.string().valid(
        'region_code', 'region_name', 'district_code', 'district_name', 'dealer_code', 'dealer_name',
        'vehicle_assignment_indicator', 'brand_code', 'objective_available_indicator', 'retail_count',
        'wholesale_count', 'distributor_count', 'retail_objective_count', 'wholesale_objective_count',
        'dealer_retail_obj', 'series_retail_ytd_obj', 'series_wholesale_ytd_obj', 'region_retail_ytd_obj',
        'region_wholesale_ytd_obj', 'retail_objective_percentage', 'wholesale_objective_percentage',
        'sales_availability_count', 'days_supply_count', 'vpc_stock_count', 'unbuilt_count',
        'company_stock_count', 'dealer_stock_count', 'intransit_othervpc_count', 'totalstock_count',
        'other_vpc_count', 'postprocess_intransit_count', 'preprocess_intransit_vpc_count',
        'hist_dealerstock_count', 'hist_tmsstock_count', 'hist_mfgstock_count', 'hist_portstock_count',
        'hist_intransitstock_count', 'sales_to_availability'
      ).required(),
      order: Joi.string().valid('asc', 'desc').required()
    })
  ).optional().description('Fields to sort aggregated data by after retrieval'),

  pagination: Joi.object({
    page: Joi.number().integer().min(1).default(1),
    page_size: Joi.number().integer().min(1).max(3000).default(25)
  }).default({ page: 1, page_size: 10 }),

  index_type: Joi.string().valid('0', '1', '2', '3', '4', '5', '6', '7').default('0').description('Index type for query selection logic')
});

// POST /summary/byRegion-Accessory - Enhanced endpoint with accessory filtering and sorting
router.post('/summary/byRegion-Accessory', validateRequest({ body: postPipDataV34Schema }), async (req, res, next) => {
  try {
    console.log('entered the v34 accessory enhanced function');

    // Helper function to convert string boolean values to actual booleans
    const convertToBoolean = (value) => {
      if (typeof value === 'boolean') return value;
      if (typeof value === 'string') return value.toUpperCase() === 'TRUE';
      return false;
    };

    const indexPar = req.query.index_par;
    logIndexPar('post_pip_data_v34', indexPar);

    // Get request parameters
    const filters = req.body.filters || null;
    const inlineFilters = req.body.inlinefilter || [];
    const sortFields = req.body.sortfields || [];
    const pagination = req.body.pagination || { page: 1, page_size: 10 };
    const indexType = req.body.index_type || '0';

    // Preprocess inline filters to convert boolean values to strings for OpenSearch compatibility
    const processedInlineFilters = inlineFilters.map(filter => {
      if (filter.field === 'objective_available_indicator' || filter.field === 'vehicle_assignment_indicator') {
        // Convert boolean values to string format expected by OpenSearch
        if (typeof filter.value === 'boolean') {
          return {
            ...filter,
            value: filter.value ? true : false
          };
        }
        // If it's already a string, ensure it's uppercase
        if (typeof filter.value === 'string') {
          return {
            ...filter,
            value: filter.value.toUpperCase()
          };
        }
      }
      return filter;
    });

    console.log('v34 filters:', JSON.stringify(filters));
    console.log('v34 inline filters:', JSON.stringify(inlineFilters));
    console.log('v34 processed inline filters:', JSON.stringify(processedInlineFilters));
    console.log('v34 sort fields:', JSON.stringify(sortFields));
    console.log('v34 index type:', indexType);

    // Determine which index to use - for index types 0, 3, 5 use the color summary index
    let indexName;
    const currentDate = new Date();
    const yearString = currentDate.getFullYear().toString();

    if (['0', '3', '5'].includes(indexType)) {
      // Use the accessory summary index for these types
      indexName = [`pipe-rgn-dlr-dist-sale-accessory-current-summary-${yearString}`];
    } else if (indexType === '6') {
      const previousYearString = (currentDate.getFullYear() - 1).toString();
      indexName = [`pipe-rgn-dlr-dist-sale-accessory-current-summary-${previousYearString}`];
    } else {
      if (filters && filters.sls_ccyymm && filters.sls_ccyymm.length > 0) {
        // Extract years from CCYYMM format (first 4 digits)
        const years = filters.sls_ccyymm.map(val => {
          const ccyymm = val.toString().padStart(6, '0');
          return parseInt(ccyymm.substring(0, 4));
        });

        const minYear = Math.min(...years);
        const maxYear = Math.max(...years);

        console.log(`v34 Min year: ${minYear}, Max year: ${maxYear}`);
        if (minYear === maxYear) {
          indexName = [`pipe-rgn-dlr-dist-sale-accessory-current-summary-${minYear}`];
        } else {
          indexName = [`pipe-rgn-dlr-dist-sale-accessory-current-summary-${minYear}`, `pipe-rgn-dlr-dist-sale-accessory-current-summary-${maxYear}`];
        }
      } else {
        // Default to current year index
        indexName = [`pipe-rgn-dlr-dist-sale-accessory-current-summary-${yearString}`];
      }
    }

    console.log('v34 index name:', indexName);

    // Execute enhanced query using the new v34 service method with OpenSearch-based filtering and sorting
    const initialResult = await pipService.executePaginatedQueryV34(
      filters,
      { page: 1, page_size: 50000 }, // Large page size for comprehensive results
      indexName,
      indexType,
      processedInlineFilters, // Pass processed inline filters to OpenSearch
      sortFields     // Pass sort fields to OpenSearch
    );

    if (!initialResult.success) {
      return next(new Error(initialResult.error));
    }

    // Get aggregated data (already filtered and sorted by OpenSearch)
    let aggregatedData = initialResult.data || [];
    console.log(`V34 Data count after OpenSearch processing: ${aggregatedData.length}`);

    // Transform data into enhanced hierarchical structure first
    const transformedData = pipService._transformToHierarchicalStructureV34(aggregatedData, pagination);

    // Apply pagination at the region level
    const totalRegions = transformedData.regionSummary.regions.length;
    const startIndex = (pagination.page - 1) * pagination.page_size;
    const endIndex = startIndex + pagination.page_size;

    // Get paginated regions
    const paginatedRegions = transformedData.regionSummary.regions.slice(startIndex, endIndex);

    // Recalculate totals for paginated regions only
    const numericFields = [
      'sales_availability_count', 'days_supply_count', 'retail_count', 'vpc_stock_count',
      'unbuilt_count', 'company_stock_count', 'dealer_stock_count', 'intransit_othervpc_count',
      'totalstock_count', 'other_vpc_count', 'postprocess_intransit_count', 'preprocess_intransit_vpc_count',
      'wholesale_count', 'hist_dealerstock_count', 'hist_tmsstock_count', 'hist_mfgstock_count',
      'hist_portstock_count', 'hist_intransitstock_count', 'distributor_count', 'retail_objective_count',
      'wholesale_objective_count', 'dealer_retail_obj', 'series_retail_ytd_obj', 'series_wholesale_ytd_obj',
      'region_retail_ytd_obj', 'region_wholesale_ytd_obj'
    ];

    const paginatedTotals = {};
    numericFields.forEach(field => {
      paginatedTotals[field] = 0;
    });

    paginatedRegions.forEach(region => {
      numericFields.forEach(field => {
        paginatedTotals[field] += (region[field] || 0);
      });
    });

    // Calculate paginated totals percentages
    const paginatedRetailCount = paginatedTotals.retail_count || 0;
    const paginatedRetailObjective = paginatedTotals.retail_objective_count || 0;
    const paginatedWholesaleCount = paginatedTotals.wholesale_count || 0;
    const paginatedWholesaleObjective = paginatedTotals.wholesale_objective_count || 0;
    const paginatedDealerStockCount = paginatedTotals.dealer_stock_count || 0;

    paginatedTotals.retail_objective_percentage = paginatedRetailObjective > 0
      ? parseFloat(((paginatedRetailCount / paginatedRetailObjective) * 100).toFixed(2))
      : 0;
    paginatedTotals.wholesale_objective_percentage = paginatedWholesaleObjective > 0
      ? parseFloat(((paginatedWholesaleCount / paginatedWholesaleObjective) * 100).toFixed(2))
      : 0;

    // Always set sales_to_availability to 0 as per requirement
    paginatedTotals.sales_to_availability = 0;

    // Filter response to include only required fields
    const filterResponseFields = (obj, level) => {
      // Base fields that are common to all levels
      const commonFields = ['sales_availability_count', 'days_supply_count', 'retail_count', 'wholesale_count',
        'distributor_count', 'vpc_stock_count', 'unbuilt_count', 'company_stock_count',
        'dealer_stock_count', 'intransit_othervpc_count', 'totalstock_count', 'other_vpc_count',
        'postprocess_intransit_count', 'preprocess_intransit_vpc_count', 'hist_dealerstock_count',
        'hist_tmsstock_count', 'hist_mfgstock_count', 'hist_portstock_count',
        'hist_intransitstock_count', 'sales_to_availability'];

      // Objective fields that should only exist at region level
      const regionOnlyFields = ['retail_objective_count', 'retail_objective_percentage',
        'wholesale_objective_count', 'wholesale_objective_percentage'];

      const filtered = {};

      if (level === 'region') {
        filtered.region_code = obj.region_code;
        filtered.region_name = obj.region_name;
        filtered.brand_code = obj.brand_code;
        filtered.objective_available_indicator = obj.objective_available_indicator;
        // Note: region_display_order is excluded from response as it's only used for sorting

        // Add all fields including objective fields for regions
        [...commonFields, ...regionOnlyFields].forEach(field => {
          filtered[field] = obj[field] || 0;
        });
      } else if (level === 'district') {
        filtered.district_code = obj.district_code;
        filtered.district_name = obj.district_name;
        filtered.brand_code = obj.brand_code;
        filtered.vehicle_assignment_indicator = obj.vehicle_assignment_indicator;

        // Add only common fields (exclude objective fields for districts)
        commonFields.forEach(field => {
          filtered[field] = obj[field] || 0;
        });
      } else if (level === 'dealer') {
        filtered.dealer_code = obj.dealer_code;
        filtered.dealer_name = obj.dealer_name;
        filtered.brand_code = obj.brand_code;
        filtered.vehicle_assignment_indicator = obj.vehicle_assignment_indicator;

        // Add only common fields (exclude objective fields for dealers)
        commonFields.forEach(field => {
          filtered[field] = obj[field] || 0;
        });
      }

      return filtered;
    };

    // Filter paginated regions
    const filteredRegions = paginatedRegions.map(region => {
      const filteredRegion = filterResponseFields(region, 'region');
      filteredRegion.districts = region.districts.map(district => {
        const filteredDistrict = filterResponseFields(district, 'district');
        filteredDistrict.dealers = district.dealers.map(dealer =>
          filterResponseFields(dealer, 'dealer')
        );
        return filteredDistrict;
      });
      return filteredRegion;
    });

    // Filter totals to include only required fields
    const filteredTotals = {};
    const totalFields = ['sales_availability_count', 'days_supply_count', 'retail_count', 'wholesale_count',
      'distributor_count', 'retail_objective_count', 'retail_objective_percentage',
      'wholesale_objective_count', 'wholesale_objective_percentage', 'vpc_stock_count',
      'unbuilt_count', 'company_stock_count', 'dealer_stock_count', 'intransit_othervpc_count',
      'totalstock_count', 'other_vpc_count', 'postprocess_intransit_count',
      'preprocess_intransit_vpc_count', 'hist_dealerstock_count', 'hist_tmsstock_count',
      'hist_mfgstock_count', 'hist_portstock_count', 'hist_intransitstock_count', 'sales_to_availability'];

    totalFields.forEach(field => {
      filteredTotals[field] = paginatedTotals[field] || 0;
    });

    // Create pagination info without total_regions
    const totalPages = Math.ceil(totalRegions / pagination.page_size);
    const updatedPaginationInfo = {
      current_page: pagination.page,
      page_size: filteredRegions.length,
      total_pages: totalPages,
      has_next_page: endIndex < totalRegions,
      has_previous_page: startIndex > 0
    };

    // Calculate count as the total number of regions before pagination
    const correctCount = totalRegions;

    // Prepare enhanced response with filtered regions
    const result = {
      data: {
        regionSummary: {
          count: correctCount,
          regions: filteredRegions,
          totals: filteredTotals
        }
      },
      pagination: updatedPaginationInfo
    };

    // Convert boolean fields in the filtered regions
    result.data.regionSummary.regions.forEach(region => {
      if (region.objective_available_indicator !== undefined) {
        region.objective_available_indicator = convertToBoolean(region.objective_available_indicator);
      }

      region.districts.forEach(district => {
        if (district.vehicle_assignment_indicator !== undefined) {
          district.vehicle_assignment_indicator = convertToBoolean(district.vehicle_assignment_indicator);
        }

        district.dealers.forEach(dealer => {
          if (dealer.vehicle_assignment_indicator !== undefined) {
            dealer.vehicle_assignment_indicator = convertToBoolean(dealer.vehicle_assignment_indicator);
          }
        });
      });
    });

    console.log(`V34 pagination: Total regions: ${totalRegions}, Page: ${pagination.page}, Regions in page: ${paginatedRegions.length}`);
    return res.json(result);
  } catch (error) {
    console.error('Error in POST /summary/byRegion-Accessory:', error);
    next(error);
  }
});

/**
 * Transform flat data array into series-based hierarchical structure grouped by series and model codes
 * @param {Array} flatData - Array of flat data objects
 * @returns {Object} Hierarchical structure with seriesSummary
 */
//Not used//
const transformToSeriesHierarchicalStructure = (flatData) => {
  if (!Array.isArray(flatData) || flatData.length === 0) {
    return {
      seriesSummary: {
        count: 0,
        series: [],
        totals: {}
      }
    };
  }

  // Group data by series and model codes
  const seriesMap = new Map();
  const totals = {};

  // Define the numeric fields to aggregate (using original database field names)
  const numericFields = [
    'sales_availability_count', 'days_supply_count', 'retail_count', 'vpc_stock_count',
    'unbuilt_count', 'company_stock_count', 'dealer_stock_count', 'intransit_othervpc_count',
    'totalstock_count', 'other_vpc_count', 'postprocess_intransit_count', 'preprocess_intransit_vpc_count',
    'wholesale_count', 'hist_dealerstock_count', 'hist_tmsstock_count', 'hist_mfgstock_count',
    'hist_portstock_count', 'hist_intransitstock_count'
  ];

  // Initialize totals
  numericFields.forEach(field => {
    totals[field] = 0;
  });

  console.log('transformToSeriesHierarchicalStructure - Processing', flatData.length, 'items');
  console.log('transformToSeriesHierarchicalStructure - First item structure:', JSON.stringify(flatData[0], null, 2));

  flatData.forEach((item, index) => {
    console.log(`Processing item ${index}:`, JSON.stringify(item, null, 2));

    // Handle series name - use a default if missing
    let seriesName = item.series_name;
    console.log(`Item ${index} series_name:`, seriesName, 'type:', typeof seriesName);

    if (!seriesName || typeof seriesName !== 'string' || seriesName.trim() === '') {
      console.log(`Item ${index} has invalid series name, using default:`, seriesName);
      seriesName = 'Unknown Series'; // Use default instead of skipping
    } else {
      seriesName = seriesName.trim();
    }
    console.log(`Item ${index} processed series name:`, seriesName);

    const modelCode = item.model_code || 'Unknown Model';

    // Initialize series if not exists
    if (!seriesMap.has(seriesName)) {
      const seriesData = {
        series_name: seriesName,
        modelCodes: new Map()
      };

      // Initialize series totals
      numericFields.forEach(field => {
        seriesData[field] = 0;
      });

      seriesMap.set(seriesName, seriesData);
    }

    const series = seriesMap.get(seriesName);

    // Initialize model code if not exists
    if (!series.modelCodes.has(modelCode)) {
      const modelData = {
        model_code: modelCode
      };

      // Initialize model totals
      numericFields.forEach(field => {
        modelData[field] = 0;
      });

      series.modelCodes.set(modelCode, modelData);
    }

    const model = series.modelCodes.get(modelCode);

    // Aggregate values using original field names
    numericFields.forEach(field => {
      const value = parseInt(item[field]) || 0;
      model[field] += value;
      series[field] += value;
      totals[field] += value;
    });
  });

  // Convert maps to arrays and structure the response
  const series = Array.from(seriesMap.values()).map(seriesData => {
    // Extract modelCodes map and other fields separately
    const { modelCodes, ...seriesFields } = seriesData;

    return {
      ...seriesFields, // This includes series_name and all numeric fields
      modelCodes: Array.from(modelCodes.values())
    };
  });

  console.log('transformToSeriesHierarchicalStructure - Final series count:', series.length);
  console.log('transformToSeriesHierarchicalStructure - Final totals:', totals);

  return {
    seriesSummary: {
      count: series.length,
      series: series,
      totals: totals
    }
  };
};
//Not used//
// POST /api/series_sales_acc_summary/pip/data schema - New endpoint with series/model code structure
const postPipDataV41Schema = Joi.object({
  filters: Joi.object({
    region_code: Joi.array().items(Joi.string()).optional(),
    district_code: Joi.array().items(Joi.string()).optional(),
    dealer_code: Joi.array().items(Joi.string()).optional(),
    transaction_date: Joi.object({
      gte: Joi.string().optional().description('Start date (yyyy-MM-dd)'),
      lte: Joi.string().optional().description('End date (yyyy-MM-dd)')
    }).optional(),
    model_year: Joi.array().items(Joi.string()).optional(),
    model_code: Joi.array().items(Joi.string()).optional(),
    fleet_flag: Joi.array().items(Joi.boolean()).optional(),
    brand_code: Joi.array().items(Joi.string()).optional(),
    segment_code: Joi.array().items(Joi.string()).optional(),
    car_trk_indicator: Joi.array().items(Joi.string()).optional(),
    dealer_type: Joi.array().items(Joi.string()).optional(),
    team_lease_indicator: Joi.array().items(Joi.string()).optional(),
    transmissiontype_code: Joi.array().items(Joi.string()).optional(),
    series_name: Joi.array().items(Joi.string()).optional(),
    grade_code: Joi.array().items(Joi.string()).optional(),
    drivetrain_code: Joi.array().items(Joi.string()).optional(),
    napc_bu_code: Joi.array().items(Joi.string()).optional(),
    sls_ccyymm: Joi.array().items(Joi.string()).optional().description('Filter by year-month in CCYYMM format (e.g., "202407")'),
    accessory_code: Joi.array().items(Joi.string()).optional(),
    accessory_desc: Joi.array().items(Joi.string()).optional()
  }).optional(),
  inlinefilter: Joi.array().items(
    Joi.object({
      field: Joi.string().valid(
        'sales_availability_count', 'days_supply_count', 'retail_count', 'vpc_stock_count',
        'unbuilt_count', 'company_stock_count', 'dealer_stock_count', 'intransit_othervpc_count',
        'totalstock_count', 'other_vpc_count', 'postprocess_intransit_count', 'preprocess_intransit_vpc_count',
        'wholesale_count', 'hist_dealerstock_count', 'hist_tmsstock_count', 'hist_mfgstock_count',
        'hist_portstock_count', 'hist_intransitstock_count', 'series_name', 'model_code'
      ).required(),
      condition: Joi.string().valid('>=', '<=', '=', '>', '<', 'contains').required(),
      value: Joi.alternatives().try(Joi.number(), Joi.string()).required()
    })
  ).optional().description('Inline filters to apply to aggregated data after retrieval'),
  sortfields: Joi.array().items(
    Joi.object({
      field: Joi.string().valid(
        'sales_availability_count', 'days_supply_count', 'retail_count', 'vpc_stock_count',
        'unbuilt_count', 'company_stock_count', 'dealer_stock_count', 'intransit_othervpc_count',
        'totalstock_count', 'other_vpc_count', 'postprocess_intransit_count', 'preprocess_intransit_vpc_count',
        'wholesale_count', 'hist_dealerstock_count', 'hist_tmsstock_count', 'hist_mfgstock_count',
        'hist_portstock_count', 'hist_intransitstock_count', 'series_name', 'model_code'
      ).required(),
      order: Joi.string().valid('asc', 'desc').required()
    })
  ).optional().description('Fields to sort aggregated data by after retrieval'),
  pagination: Joi.object({
    page: Joi.number().integer().min(1).default(1),
    page_size: Joi.number().integer().min(1).max(3000).default(25)
  }).default({ page: 1, page_size: 10 }),
  index_type: Joi.string().valid('0', '1', '2', '3', '4', '5', '6', '7').default('currmth').description('Index type for date-based index selection')
});

// POST /api/series_sales_acc_summary/pip/data - Get PIP data using POST request with series/model code structure
router.post('/api/series_sales_acc_summary/pip/data', validateRequest({ body: postPipDataV41Schema }), async (req, res, next) => {
  try {
    console.log('entered the v41 function');
    console.log('v41 request body:', JSON.stringify(req.body, null, 2));
    const indexPar = req.query.index_par;
    logIndexPar('post_pip_data_v41', indexPar);

    // Inline transformation function
    const transformToSeriesSummary = (flatData) => {
      try {
        // Handle empty or invalid input
        if (!Array.isArray(flatData) || flatData.length === 0) {
          console.log('transformToSeriesSummary: Empty or invalid input data');
          return {
            seriesSummary: {
              count: 0,
              series: [],
              totals: getEmptyTotals()
            }
          };
        }

        console.log(`transformToSeriesSummary: Processing ${flatData.length} flat data items`);

        // Define all numeric fields that need aggregation
        const numericFields = [
          'sales_availability_count', 'days_supply_count', 'retail_count', 'vpc_stock_count',
          'unbuilt_count', 'company_stock_count', 'dealer_stock_count', 'intransit_othervpc_count',
          'totalstock_count', 'other_vpc_count', 'postprocess_intransit_count',
          'preprocess_intransit_vpc_count', 'wholesale_count', 'hist_dealerstock_count',
          'hist_tmsstock_count', 'hist_mfgstock_count', 'hist_portstock_count', 'hist_intransitstock_count'
        ];

        // Group data by series_name
        const seriesMap = new Map();
        const overallTotals = getEmptyTotals();

        flatData.forEach((item, index) => {
          try {
            if (!item || typeof item !== 'object') {
              console.warn(`transformToSeriesSummary: Skipping invalid item at index ${index}:`, item);
              return;
            }

            const seriesName = item.series_name || 'Unknown Series';
            const modelCode = item.model_code || 'Unknown Model';

            console.log(`Processing item ${index}: series=${seriesName}, model=${modelCode}`);

            // Initialize series if not exists
            if (!seriesMap.has(seriesName)) {
              console.log(`Creating new series: ${seriesName}`);
              seriesMap.set(seriesName, {
                series_name: seriesName,
                brand_code: item.brand_code || null,
                ...getEmptyTotals(),
                modelCodes: []
              });
            }

            const series = seriesMap.get(seriesName);

            // Create model code object with all numeric fields
            const modelCodeData = {
              model_code: modelCode
            };

            // Process each numeric field and aggregate at series level
            numericFields.forEach(field => {
              let value = 0;

              // Handle different data types and null/undefined values
              if (item[field] !== null && item[field] !== undefined) {
                if (typeof item[field] === 'number') {
                  value = item[field];
                } else if (typeof item[field] === 'string') {
                  const parsed = parseInt(item[field]);
                  value = isNaN(parsed) ? 0 : parsed;
                }
              }

              // Add to model code data
              modelCodeData[field] = value;

              // Add to series totals (this is the key aggregation step)
              const previousSeriesValue = series[field];
              series[field] += value;

              // Add to overall totals
              overallTotals[field] += value;

              // Log aggregation for key fields
              if (field === 'sales_availability_count' || field === 'retail_count') {
                console.log(`${field}: model_value=${value}, series_before=${previousSeriesValue}, series_after=${series[field]}`);
              }
            });

            // Add model code to series
            series.modelCodes.push(modelCodeData);
            console.log(`Added model ${modelCode} to series ${seriesName}. Series now has ${series.modelCodes.length} models`);

          } catch (itemError) {
            console.error(`transformToSeriesSummary: Error processing item at index ${index}:`, itemError.message);
            // Continue processing other items
          }
        });

        // Convert map to array and sort by series name
        const seriesArray = Array.from(seriesMap.values()).sort((a, b) =>
          a.series_name.localeCompare(b.series_name)
        );

        console.log(`transformToSeriesSummary: Created ${seriesArray.length} series with ${flatData.length} total model codes`);

        // Validate aggregation: series totals should equal sum of their model codes
        seriesArray.forEach(series => {
          const modelCodeSum = series.modelCodes.reduce((sum, model) => sum + (model.sales_availability_count || 0), 0);
          console.log(`Series ${series.series_name}: series_total=${series.sales_availability_count}, model_codes_sum=${modelCodeSum}, models_count=${series.modelCodes.length}`);

          if (series.sales_availability_count !== modelCodeSum) {
            console.warn(`AGGREGATION MISMATCH for ${series.series_name}: series=${series.sales_availability_count} vs models_sum=${modelCodeSum}`);
          }
        });

        // Validate overall totals
        const calculatedOverallTotal = seriesArray.reduce((sum, series) => sum + (series.sales_availability_count || 0), 0);
        console.log(`Overall totals validation: calculated=${calculatedOverallTotal}, stored=${overallTotals.sales_availability_count}`);

        const result = {
          seriesSummary: {
            count: seriesArray.length,
            series: seriesArray,
            totals: overallTotals
          }
        };

        // Validate the result structure
        if (!result.seriesSummary || !Array.isArray(result.seriesSummary.series)) {
          throw new Error('Invalid result structure created');
        }

        return result;

      } catch (error) {
        console.error('transformToSeriesSummary: Transformation failed:', error.message);
        throw new Error(`Series summary transformation failed: ${error.message}`);
      }
    };

    // Helper function to get empty totals
    const getEmptyTotals = () => {
      return {
        sales_availability_count: 0,
        days_supply_count: 0,
        retail_count: 0,
        vpc_stock_count: 0,
        unbuilt_count: 0,
        company_stock_count: 0,
        dealer_stock_count: 0,
        intransit_othervpc_count: 0,
        totalstock_count: 0,
        other_vpc_count: 0,
        postprocess_intransit_count: 0,
        preprocess_intransit_vpc_count: 0,
        wholesale_count: 0,
        hist_dealerstock_count: 0,
        hist_tmsstock_count: 0,
        hist_mfgstock_count: 0,
        hist_portstock_count: 0,
        hist_intransitstock_count: 0,
        sales_to_availability: 0
      };
    };

    // Create a copy of filters to avoid modifying the original request
    const filters = req.body.filters ? { ...req.body.filters } : null;

    // Convert all filter field values to uppercase if they are strings
    if (filters) {
      Object.keys(filters).forEach(key => {
        if (Array.isArray(filters[key])) {
          // Convert array values to uppercase if they are strings
          filters[key] = filters[key].map(value =>
            typeof value === 'string' ? value.toUpperCase() : value
          );
        } else if (typeof filters[key] === 'string') {
          // Convert single string values to uppercase
          filters[key] = filters[key].toUpperCase();
        }
        // Note: transaction_date object with gte/lte properties is left unchanged as dates should not be uppercased
      });
    }

    console.log('v41 filters:', JSON.stringify(filters));

    // Determine which index to use based on index_type
    const indexType = req.body.index_type;
    let indexName;
    const currentDate = new Date();
    const yearString = currentDate.getFullYear().toString();

    if (indexType == '0' || indexType == '1' || indexType == '2' || indexType == '3' || indexType == '4' || indexType == '5') {
      indexName = [`${ACCESSORY_INDEX}-${yearString}`];
    } else if (indexType == '6') {
      const previousYearString = (currentDate.getFullYear() - 1).toString();
      indexName = [`${ACCESSORY_INDEX}-${previousYearString}`];
    } else {
      if (filters && filters.sls_ccyymm && filters.sls_ccyymm.length > 0) {
        // Extract years from CCYYMM format (first 4 digits)
        const years = filters.sls_ccyymm.map(val => {
          const ccyymm = val.toString().padStart(6, '0');
          return parseInt(ccyymm.substring(0, 4));
        });

        const minYear = Math.min(...years);
        const maxYear = Math.max(...years);

        console.log(`V41 Min year: ${minYear}, Max year: ${maxYear}`);
        if (minYear === maxYear) {
          indexName = [`${ACCESSORY_INDEX}-${minYear}`];
        } else {
          indexName = [`${ACCESSORY_INDEX}-${minYear}`, `${ACCESSORY_INDEX}-${maxYear}`];
        }
      } else {
        // Default to current year index
        indexName = [`${ACCESSORY_INDEX}-${yearString}`];
      }
    }

    console.log('v41 index name:', indexName);

    // Execute query using the new v41 service method
    const initialResult = await pipService.executePaginatedQueryV41(
      filters || null,
      { page: 1, page_size: 10000 }, // Get a large page to apply filtering and sorting first
      indexName
    );

    console.log('v41 initialResult success:', initialResult.success);
    console.log('v41 initialResult data length:', initialResult.data ? initialResult.data.length : 0);

    if (!initialResult.success) {
      console.error('v41 query failed:', initialResult.error);
      return next(new Error(initialResult.error));
    }

    // Get aggregated data to apply inline filtering and sorting
    let aggregatedData = initialResult.data || [];
    console.log('v41 aggregatedData length:', aggregatedData.length);

    // Debug: Log sample of raw data from OpenSearch
    if (aggregatedData.length > 0) {
      console.log('v41 Sample raw data from OpenSearch:');
      aggregatedData.slice(0, 3).forEach((item, index) => {
        console.log(`Sample ${index}:`, JSON.stringify(item, null, 2));
      });
    }

    // Apply inline filtering if provided (on flat data before transformation)
    if (req.body.inlinefilter && Array.isArray(req.body.inlinefilter) && req.body.inlinefilter.length > 0) {
      console.log(`Applying ${req.body.inlinefilter.length} inline filters to v41 aggregated data`);

      aggregatedData = aggregatedData.filter(item => {
        return req.body.inlinefilter.every(filter => {
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
              // Full text search - convert both to string and check if fieldValue contains the search term
              const fieldStr = String(fieldValue).toLowerCase();
              const searchStr = String(filter.value).toLowerCase();
              return fieldStr.includes(searchStr);
            default:
              return true;
          }
        });
      });

      console.log(`After v41 inline filtering, ${aggregatedData.length} items remain`);
    }

    // Transform flat data to hierarchical series summary structure
    console.log('v41 transforming data to series summary format');
    let transformedResult;

    try {
      transformedResult = transformToSeriesSummary(aggregatedData);
      console.log('v41 transformation complete, series count:', transformedResult.seriesSummary.count);

      // Validate the transformation result
      if (!transformedResult || !transformedResult.seriesSummary) {
        throw new Error('Invalid transformation result: missing seriesSummary');
      }

      if (!Array.isArray(transformedResult.seriesSummary.series)) {
        throw new Error('Invalid transformation result: series is not an array');
      }

    } catch (transformError) {
      console.error('v41 transformation failed:', transformError.message);
      return next(new Error(`Data transformation failed: ${transformError.message}`));
    }

    // Apply sorting to series-level data if provided
    if (req.body.sortfields && Array.isArray(req.body.sortfields) && req.body.sortfields.length > 0) {
      console.log(`Applying v41 sorting by ${req.body.sortfields.length} fields to series data`);

      transformedResult.seriesSummary.series.sort((a, b) => {
        for (const sort of req.body.sortfields) {
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

    // Apply pagination to series data
    const pagination = req.body.pagination || { page: 1, page_size: 100 };
    const totalSeries = transformedResult.seriesSummary.series.length;
    const startIndex = (pagination.page - 1) * pagination.page_size;
    const endIndex = startIndex + pagination.page_size;

    // Get paginated series
    const paginatedSeries = transformedResult.seriesSummary.series.slice(startIndex, endIndex);

    // Recalculate totals for paginated series only
    const paginatedTotals = getEmptyTotals();
    paginatedSeries.forEach(series => {
      Object.keys(paginatedTotals).forEach(field => {
        paginatedTotals[field] += (series[field] || 0);
      });
    });

    // Create final response with pagination
    const finalResponse = {
      seriesSummary: {
        count: paginatedSeries.length,
        series: paginatedSeries,
        totals: paginatedTotals
      },
      pagination: {
        current_page: pagination.page,
        page_size: paginatedSeries.length,
        total_pages: Math.ceil(totalSeries / pagination.page_size),
        has_next_page: endIndex < totalSeries,
        has_previous_page: startIndex > 0
      }
    };

    // Return the hierarchical series summary structure with pagination
    console.log('v41 returning series summary structure with pagination');
    console.log(`Total series: ${totalSeries}, Paginated series: ${paginatedSeries.length}, Page: ${pagination.page}`);
    return res.json(finalResponse);

  } catch (error) {
    console.error('Error in POST /api/v41/pip/data:', error);
    next(error);
  }
});

// POST /api/series_sales_color_summary/pip/data schema - New endpoint with series/model code structure including color filters
const postPipDataV42Schema = Joi.object({
  filters: Joi.object({
    region_code: Joi.array().items(Joi.string()).optional(),
    district_code: Joi.array().items(Joi.string()).optional(),
    dealer_code: Joi.array().items(Joi.string()).optional(),
    transaction_date: Joi.object({
      gte: Joi.string().optional().description('Start date (yyyy-MM-dd)'),
      lte: Joi.string().optional().description('End date (yyyy-MM-dd)')
    }).optional(),
    model_year: Joi.array().items(Joi.string()).optional(),
    model_code: Joi.array().items(Joi.string()).optional(),
    fleet_flag: Joi.array().items(Joi.boolean()).optional(),
    brand_code: Joi.array().items(Joi.string()).optional(),
    segment_code: Joi.array().items(Joi.string()).optional(),
    car_trk_indicator: Joi.array().items(Joi.string()).optional(),
    dealer_type: Joi.array().items(Joi.string()).optional(),
    team_lease_indicator: Joi.array().items(Joi.string()).optional(),
    transmissiontype_code: Joi.array().items(Joi.string()).optional(),
    series_name: Joi.array().items(Joi.string()).optional(),
    grade_code: Joi.array().items(Joi.string()).optional(),
    drivetrain_code: Joi.array().items(Joi.string()).optional(),
    napc_bu_code: Joi.array().items(Joi.string()).optional(),
    sls_ccyymm: Joi.array().items(Joi.string()).optional().description('Filter by year-month in CCYYMM format (e.g., "202407")'),
    exterior_color_code: Joi.array().items(Joi.string()).optional().description('Filter by exterior color codes'),
    interior_color_code: Joi.array().items(Joi.string()).optional().description('Filter by interior color codes')
  }).optional(),
  inlinefilter: Joi.array().items(
    Joi.object({
      field: Joi.string().valid(
        'sales_availability_count', 'days_supply_count', 'retail_count', 'vpc_stock_count',
        'unbuilt_count', 'company_stock_count', 'dealer_stock_count', 'intransit_othervpc_count',
        'totalstock_count', 'other_vpc_count', 'postprocess_intransit_count', 'preprocess_intransit_vpc_count',
        'wholesale_count', 'hist_dealerstock_count', 'hist_tmsstock_count', 'hist_mfgstock_count',
        'hist_portstock_count', 'hist_intransitstock_count', 'series_name', 'model_code'
      ).required(),
      condition: Joi.string().valid('>=', '<=', '=', '>', '<', 'contains').required(),
      value: Joi.alternatives().try(Joi.number(), Joi.string()).required()
    })
  ).optional().description('Inline filters to apply to aggregated data after retrieval'),
  sortfields: Joi.array().items(
    Joi.object({
      field: Joi.string().valid(
        'sales_availability_count', 'days_supply_count', 'retail_count', 'vpc_stock_count',
        'unbuilt_count', 'company_stock_count', 'dealer_stock_count', 'intransit_othervpc_count',
        'totalstock_count', 'other_vpc_count', 'postprocess_intransit_count', 'preprocess_intransit_vpc_count',
        'wholesale_count', 'hist_dealerstock_count', 'hist_tmsstock_count', 'hist_mfgstock_count',
        'hist_portstock_count', 'hist_intransitstock_count', 'series_name', 'model_code'
      ).required(),
      order: Joi.string().valid('asc', 'desc').required()
    })
  ).optional().description('Fields to sort aggregated data by after retrieval'),
  pagination: Joi.object({
    page: Joi.number().integer().min(1).default(1),
    page_size: Joi.number().integer().min(1).max(3000).default(25)
  }).default({ page: 1, page_size: 10 }),
  index_type: Joi.string().valid('0', '1', '2', '3', '4', '5', '6', '7').default('currmth').description('Index type for date-based index selection')
});

// POST /api/series_sales_color_summary/pip/data - Get PIP data using POST request with series/model code structure including color filters
router.post('/api/series_sales_color_summary/pip/data', validateRequest({ body: postPipDataV42Schema }), async (req, res, next) => {
  try {
    console.log('entered the v42 function');
    console.log('v42 request body:', JSON.stringify(req.body, null, 2));
    const indexPar = req.query.index_par;
    logIndexPar('post_pip_data_v42', indexPar);

    // Inline transformation function (same as v41)
    const transformToSeriesSummary = (flatData) => {
      try {
        // Handle empty or invalid input
        if (!Array.isArray(flatData) || flatData.length === 0) {
          console.log('transformToSeriesSummary: Empty or invalid input data');
          return {
            seriesSummary: {
              count: 0,
              series: [],
              totals: getEmptyTotals()
            }
          };
        }

        console.log(`transformToSeriesSummary: Processing ${flatData.length} flat data items`);

        // Define all numeric fields that need aggregation
        const numericFields = [
          'sales_availability_count', 'days_supply_count', 'retail_count', 'vpc_stock_count',
          'unbuilt_count', 'company_stock_count', 'dealer_stock_count', 'intransit_othervpc_count',
          'totalstock_count', 'other_vpc_count', 'postprocess_intransit_count',
          'preprocess_intransit_vpc_count', 'wholesale_count', 'hist_dealerstock_count',
          'hist_tmsstock_count', 'hist_mfgstock_count', 'hist_portstock_count', 'hist_intransitstock_count'
        ];

        // Group data by series_name
        const seriesMap = new Map();
        const overallTotals = getEmptyTotals();

        flatData.forEach((item, index) => {
          try {
            if (!item || typeof item !== 'object') {
              console.warn(`transformToSeriesSummary: Skipping invalid item at index ${index}:`, item);
              return;
            }

            const seriesName = item.series_name || 'Unknown Series';
            const modelCode = item.model_code || 'Unknown Model';

            console.log(`Processing item ${index}: series=${seriesName}, model=${modelCode}`);

            // Initialize series if not exists
            if (!seriesMap.has(seriesName)) {
              console.log(`Creating new series: ${seriesName}`);
              seriesMap.set(seriesName, {
                series_name: seriesName,
                brand_code: item.brand_code || null,
                ...getEmptyTotals(),
                modelCodes: []
              });
            }

            const series = seriesMap.get(seriesName);

            // Create model code object with all numeric fields
            const modelCodeData = {
              model_code: modelCode
            };

            // Process each numeric field and aggregate at series level
            numericFields.forEach(field => {
              let value = 0;

              // Handle different data types and null/undefined values
              if (item[field] !== null && item[field] !== undefined) {
                if (typeof item[field] === 'number') {
                  value = item[field];
                } else if (typeof item[field] === 'string') {
                  const parsed = parseInt(item[field]);
                  value = isNaN(parsed) ? 0 : parsed;
                }
              }

              // Add to model code data
              modelCodeData[field] = value;

              // Add to series totals (this is the key aggregation step)
              const previousSeriesValue = series[field];
              series[field] += value;

              // Add to overall totals
              overallTotals[field] += value;

              // Log aggregation for key fields
              if (field === 'sales_availability_count' || field === 'retail_count') {
                console.log(`${field}: model_value=${value}, series_before=${previousSeriesValue}, series_after=${series[field]}`);
              }
            });

            // Add model code to series
            series.modelCodes.push(modelCodeData);
            console.log(`Added model ${modelCode} to series ${seriesName}. Series now has ${series.modelCodes.length} models`);

          } catch (itemError) {
            console.error(`transformToSeriesSummary: Error processing item at index ${index}:`, itemError.message);
            // Continue processing other items
          }
        });

        // Convert map to array and sort by series name
        const seriesArray = Array.from(seriesMap.values()).sort((a, b) =>
          a.series_name.localeCompare(b.series_name)
        );

        console.log(`transformToSeriesSummary: Created ${seriesArray.length} series with ${flatData.length} total model codes`);

        // Validate aggregation: series totals should equal sum of their model codes
        seriesArray.forEach(series => {
          const modelCodeSum = series.modelCodes.reduce((sum, model) => sum + (model.sales_availability_count || 0), 0);
          console.log(`Series ${series.series_name}: series_total=${series.sales_availability_count}, model_codes_sum=${modelCodeSum}, models_count=${series.modelCodes.length}`);

          if (series.sales_availability_count !== modelCodeSum) {
            console.warn(`AGGREGATION MISMATCH for ${series.series_name}: series=${series.sales_availability_count} vs models_sum=${modelCodeSum}`);
          }
        });

        // Validate overall totals
        const calculatedOverallTotal = seriesArray.reduce((sum, series) => sum + (series.sales_availability_count || 0), 0);
        console.log(`Overall totals validation: calculated=${calculatedOverallTotal}, stored=${overallTotals.sales_availability_count}`);

        const result = {
          seriesSummary: {
            count: seriesArray.length,
            series: seriesArray,
            totals: overallTotals
          }
        };

        // Validate the result structure
        if (!result.seriesSummary || !Array.isArray(result.seriesSummary.series)) {
          throw new Error('Invalid result structure created');
        }

        return result;

      } catch (error) {
        console.error('transformToSeriesSummary: Transformation failed:', error.message);
        throw new Error(`Series summary transformation failed: ${error.message}`);
      }
    };

    // Helper function to get empty totals (same as v41)
    const getEmptyTotals = () => {
      return {
        sales_availability_count: 0,
        days_supply_count: 0,
        retail_count: 0,
        vpc_stock_count: 0,
        unbuilt_count: 0,
        company_stock_count: 0,
        dealer_stock_count: 0,
        intransit_othervpc_count: 0,
        totalstock_count: 0,
        other_vpc_count: 0,
        postprocess_intransit_count: 0,
        preprocess_intransit_vpc_count: 0,
        wholesale_count: 0,
        hist_dealerstock_count: 0,
        hist_tmsstock_count: 0,
        hist_mfgstock_count: 0,
        hist_portstock_count: 0,
        hist_intransitstock_count: 0,
        sales_to_availability: 0
      };
    };

    // Create a copy of filters to avoid modifying the original request
    const filters = req.body.filters ? { ...req.body.filters } : null;

    // Convert all filter field values to uppercase if they are strings
    if (filters) {
      Object.keys(filters).forEach(key => {
        if (Array.isArray(filters[key])) {
          // Convert array values to uppercase if they are strings
          filters[key] = filters[key].map(value =>
            typeof value === 'string' ? value.toUpperCase() : value
          );
        } else if (typeof filters[key] === 'string') {
          // Convert single string values to uppercase
          filters[key] = filters[key].toUpperCase();
        }
        // Note: transaction_date object with gte/lte properties is left unchanged as dates should not be uppercased
      });
    }

    console.log('v42 filters:', JSON.stringify(filters));

    // Determine which index to use based on index_type (using COLOR_INDEX for color data)
    const indexType = req.body.index_type;
    let indexName;
    const currentDate = new Date();
    const yearString = currentDate.getFullYear().toString();

    if (indexType == '0' || indexType == '1' || indexType == '2' || indexType == '3' || indexType == '4' || indexType == '5') {
      indexName = [`${COLOR_INDEX}-${yearString}`];
    } else if (indexType == '6') {
      const previousYearString = (currentDate.getFullYear() - 1).toString();
      indexName = [`${COLOR_INDEX}-${previousYearString}`];
    } else {
      if (filters && filters.sls_ccyymm && filters.sls_ccyymm.length > 0) {
        // Extract years from CCYYMM format (first 4 digits)
        const years = filters.sls_ccyymm.map(val => {
          const ccyymm = val.toString().padStart(6, '0');
          return parseInt(ccyymm.substring(0, 4));
        });

        const minYear = Math.min(...years);
        const maxYear = Math.max(...years);

        console.log(`V42 Min year: ${minYear}, Max year: ${maxYear}`);
        if (minYear === maxYear) {
          indexName = [`${COLOR_INDEX}-${minYear}`];
        } else {
          indexName = [`${COLOR_INDEX}-${minYear}`, `${COLOR_INDEX}-${maxYear}`];
        }
      } else {
        // Default to current year index
        indexName = [`${COLOR_INDEX}-${yearString}`];
      }
    }

    console.log('v42 index name:', indexName);

    // Execute query using the new v42 service method
    const initialResult = await pipService.executePaginatedQueryV42(
      filters || null,
      { page: 1, page_size: 10000 }, // Get a large page to apply filtering and sorting first
      indexName
    );

    console.log('v42 initialResult success:', initialResult.success);
    console.log('v42 initialResult data length:', initialResult.data ? initialResult.data.length : 0);

    if (!initialResult.success) {
      console.error('v42 query failed:', initialResult.error);
      return next(new Error(initialResult.error));
    }

    // Get aggregated data to apply inline filtering and sorting
    let aggregatedData = initialResult.data || [];
    console.log('v42 aggregatedData length:', aggregatedData.length);

    // Debug: Log sample of raw data from OpenSearch
    if (aggregatedData.length > 0) {
      console.log('v42 Sample raw data from OpenSearch:');
      aggregatedData.slice(0, 3).forEach((item, index) => {
        console.log(`Sample ${index}:`, JSON.stringify(item, null, 2));
      });
    }

    // Apply inline filtering if provided (on flat data before transformation)
    if (req.body.inlinefilter && Array.isArray(req.body.inlinefilter) && req.body.inlinefilter.length > 0) {
      console.log(`Applying ${req.body.inlinefilter.length} inline filters to v42 aggregated data`);

      aggregatedData = aggregatedData.filter(item => {
        return req.body.inlinefilter.every(filter => {
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
              // Full text search - convert both to string and check if fieldValue contains the search term
              const fieldStr = String(fieldValue).toLowerCase();
              const searchStr = String(filter.value).toLowerCase();
              return fieldStr.includes(searchStr);
            default:
              return true;
          }
        });
      });

      console.log(`After v42 inline filtering, ${aggregatedData.length} items remain`);
    }

    // Transform flat data to hierarchical series summary structure
    console.log('v42 transforming data to series summary format');
    let transformedResult;

    try {
      transformedResult = transformToSeriesSummary(aggregatedData);
      console.log('v42 transformation complete, series count:', transformedResult.seriesSummary.count);

      // Validate the transformation result
      if (!transformedResult || !transformedResult.seriesSummary) {
        throw new Error('Invalid transformation result: missing seriesSummary');
      }

      if (!Array.isArray(transformedResult.seriesSummary.series)) {
        throw new Error('Invalid transformation result: series is not an array');
      }

    } catch (transformError) {
      console.error('v42 transformation failed:', transformError.message);
      return next(new Error(`Data transformation failed: ${transformError.message}`));
    }

    // Apply sorting to series-level data if provided
    if (req.body.sortfields && Array.isArray(req.body.sortfields) && req.body.sortfields.length > 0) {
      console.log(`Applying v42 sorting by ${req.body.sortfields.length} fields to series data`);

      transformedResult.seriesSummary.series.sort((a, b) => {
        for (const sort of req.body.sortfields) {
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

    // Apply pagination to series data
    const pagination = req.body.pagination || { page: 1, page_size: 100 };
    const totalSeries = transformedResult.seriesSummary.series.length;
    const startIndex = (pagination.page - 1) * pagination.page_size;
    const endIndex = startIndex + pagination.page_size;

    // Get paginated series
    const paginatedSeries = transformedResult.seriesSummary.series.slice(startIndex, endIndex);

    // Recalculate totals for paginated series only
    const paginatedTotals = getEmptyTotals();
    paginatedSeries.forEach(series => {
      Object.keys(paginatedTotals).forEach(field => {
        paginatedTotals[field] += (series[field] || 0);
      });
    });

    // Create final response with pagination
    const finalResponse = {
      seriesSummary: {
        count: paginatedSeries.length,
        series: paginatedSeries,
        totals: paginatedTotals
      },
      pagination: {
        current_page: pagination.page,
        page_size: paginatedSeries.length,
        total_pages: Math.ceil(totalSeries / pagination.page_size),
        has_next_page: endIndex < totalSeries,
        has_previous_page: startIndex > 0
      }
    };

    // Return the hierarchical series summary structure with pagination
    console.log('v42 returning series summary structure with pagination');
    console.log(`Total series: ${totalSeries}, Paginated series: ${paginatedSeries.length}, Page: ${pagination.page}`);
    return res.json(finalResponse);

  } catch (error) {
    console.error('Error in POST /api/v42/pip/data:', error);
    next(error);
  }
});

// POST /api/dealer_acc_summ/pip/data schema - New endpoint for dealer-level aggregation
const postPipDataV51Schema = Joi.object({
  filters: Joi.object({
    region_code: Joi.array().items(Joi.string()).optional(),
    district_code: Joi.array().items(Joi.string()).optional(),
    dealer_code: Joi.array().items(Joi.string()).optional(),
    transaction_date: Joi.object({
      gte: Joi.string().optional().description('Start date (yyyy-MM-dd)'),
      lte: Joi.string().optional().description('End date (yyyy-MM-dd)')
    }).optional(),
    model_year: Joi.array().items(Joi.string()).optional(),
    model_code: Joi.array().items(Joi.string()).optional(),
    fleet_flag: Joi.array().items(Joi.boolean()).optional(),
    brand_code: Joi.array().items(Joi.string()).optional(),
    segment_code: Joi.array().items(Joi.string()).optional(),
    car_trk_indicator: Joi.array().items(Joi.string()).optional(),
    dealer_type: Joi.array().items(Joi.string()).optional(),
    team_lease_indicator: Joi.array().items(Joi.string()).optional(),
    transmissiontype_code: Joi.array().items(Joi.string()).optional(),
    series_name: Joi.array().items(Joi.string()).optional(),
    grade_code: Joi.array().items(Joi.string()).optional(),
    drivetrain_code: Joi.array().items(Joi.string()).optional(),
    napc_bu_code: Joi.array().items(Joi.string()).optional(),
    sls_ccyymm: Joi.array().items(Joi.string()).optional().description('Filter by year-month in CCYYMM format (e.g., "202407")'),
    accessory_code: Joi.array().items(Joi.string()).optional(),
    accessory_desc: Joi.array().items(Joi.string()).optional()
  }).optional(),
  inlinefilter: Joi.array().items(
    Joi.object({
      field: Joi.string().valid(
        'sales_availability_count', 'days_supply_count', 'retail_count', 'vpc_stock_count',
        'unbuilt_count', 'company_stock_count', 'dealer_stock_count', 'intransit_othervpc_count',
        'totalstock_count', 'other_vpc_count', 'postprocess_intransit_count', 'preprocess_intransit_vpc_count',
        'wholesale_count', 'hist_dealerstock_count', 'hist_tmsstock_count', 'hist_mfgstock_count',
        'hist_portstock_count', 'hist_intransitstock_count'
      ).required(),
      condition: Joi.string().valid('>=', '<=', '=', '>', '<').required(),
      value: Joi.number().required()
    })
  ).optional().description('Inline filters to apply to dealer data after retrieval'),
  sortfields: Joi.array().items(
    Joi.object({
      field: Joi.string().valid(
        'sales_availability_count', 'days_supply_count', 'retail_count', 'vpc_stock_count',
        'unbuilt_count', 'company_stock_count', 'dealer_stock_count', 'intransit_othervpc_count',
        'totalstock_count', 'other_vpc_count', 'postprocess_intransit_count', 'preprocess_intransit_vpc_count',
        'wholesale_count', 'hist_dealerstock_count', 'hist_tmsstock_count', 'hist_mfgstock_count',
        'hist_portstock_count', 'hist_intransitstock_count', 'dealerCode', 'dealerName'
      ).required(),
      order: Joi.string().valid('asc', 'desc').required()
    })
  ).optional().description('Fields to sort dealer data by after retrieval'),
  pagination: Joi.object({
    page: Joi.number().integer().min(1).default(1),
    page_size: Joi.number().integer().min(1).max(3000).default(25)
  }).default({ page: 1, page_size: 10 }),
  index_type: Joi.string().valid('0', '1', '2', '3', '4', '5', '6', '7').default('currmth').description('Index type for date-based index selection')
});

// POST /api/dealer_acc_summ/pip/data - Get dealer-level aggregated data
router.post('/api/dealer_acc_summ/pip/data', validateRequest({ body: postPipDataV51Schema }), async (req, res, next) => {
  try {
    console.log('entered the v51 function');
    console.log('v51 request body:', JSON.stringify(req.body, null, 2));
    const indexPar = req.query.index_par;
    logIndexPar('post_pip_data_v51', indexPar);

    // Inline transformation function for dealer summary
    const transformToDealerSummary = (flatData) => {
      try {
        // Handle empty or invalid input
        if (!Array.isArray(flatData) || flatData.length === 0) {
          console.log('transformToDealerSummary: Empty or invalid input data');
          return {
            dealerSummary: {
              count: 0,
              dealers: [],
              totals: getEmptyTotals()
            }
          };
        }

        console.log(`transformToDealerSummary: Processing ${flatData.length} flat data items`);

        // Define all numeric fields that need aggregation
        const numericFields = [
          'sales_availability_count', 'days_supply_count', 'retail_count', 'vpc_stock_count',
          'unbuilt_count', 'company_stock_count', 'dealer_stock_count', 'intransit_othervpc_count',
          'totalstock_count', 'other_vpc_count', 'postprocess_intransit_count',
          'preprocess_intransit_vpc_count', 'wholesale_count', 'hist_dealerstock_count',
          'hist_tmsstock_count', 'hist_mfgstock_count', 'hist_portstock_count', 'hist_intransitstock_count'
        ];

        // Group data by dealer_code
        const dealerMap = new Map();
        const overallTotals = getEmptyTotals();

        flatData.forEach((item, index) => {
          try {
            if (!item || typeof item !== 'object') {
              console.warn(`transformToDealerSummary: Skipping invalid item at index ${index}:`, item);
              return;
            }

            const dealerCode = item.dealer_code || 'Unknown Dealer';
            const dealerName = item.dealer_name || 'Unknown Name';

            console.log(`Processing item ${index}: dealer=${dealerCode}, name=${dealerName}`);

            // Initialize dealer if not exists
            if (!dealerMap.has(dealerCode)) {
              console.log(`Creating new dealer: ${dealerCode}`);
              dealerMap.set(dealerCode, {
                dealerCode: dealerCode,
                dealerName: dealerName,
                brand_code: item.brand_code || null,
                national_ranking: item.national_ranking.rank || null,
                regional_ranking: item.regional_ranking.rank || null,
                ...getEmptyTotals()
              });
            }

            const dealer = dealerMap.get(dealerCode);

            // Process each numeric field and aggregate at dealer level
            numericFields.forEach(field => {
              let value = 0;

              // Handle different data types and null/undefined values
              if (item[field] !== null && item[field] !== undefined) {
                if (typeof item[field] === 'number') {
                  value = item[field];
                } else if (typeof item[field] === 'string') {
                  const parsed = parseInt(item[field]);
                  value = isNaN(parsed) ? 0 : parsed;
                }
              }

              // Add to dealer totals (this is the key aggregation step)
              const previousDealerValue = dealer[field];
              dealer[field] += value;

              // Add to overall totals
              overallTotals[field] += value;

              // Log aggregation for key fields
              if (field === 'sales_availability_count' || field === 'retail_count') {
                console.log(`${field}: item_value=${value}, dealer_before=${previousDealerValue}, dealer_after=${dealer[field]}`);
              }
            });

            console.log(`Updated dealer ${dealerCode} totals`);

          } catch (itemError) {
            console.error(`transformToDealerSummary: Error processing item at index ${index}:`, itemError.message);
            // Continue processing other items
          }
        });

        // Convert map to array and sort by dealer code
        const dealersArray = Array.from(dealerMap.values()).sort((a, b) =>
          a.dealerCode.localeCompare(b.dealerCode)
        );

        console.log(`transformToDealerSummary: Created ${dealersArray.length} dealers from ${flatData.length} total records`);

        // Validate overall totals
        const calculatedOverallTotal = dealersArray.reduce((sum, dealer) => sum + (dealer.sales_availability_count || 0), 0);
        console.log(`Overall totals validation: calculated=${calculatedOverallTotal}, stored=${overallTotals.sales_availability_count}`);

        const result = {
          dealerSummary: {
            count: dealersArray.length,
            dealers: dealersArray,
            totals: overallTotals
          }
        };

        // Validate the result structure
        if (!result.dealerSummary || !Array.isArray(result.dealerSummary.dealers)) {
          throw new Error('Invalid result structure created');
        }

        return result;

      } catch (error) {
        console.error('transformToDealerSummary: Transformation failed:', error.message);
        throw new Error(`Dealer summary transformation failed: ${error.message}`);
      }
    };

    // Helper function to get empty totals
    const getEmptyTotals = () => {
      return {
        sales_availability_count: 0,
        days_supply_count: 0,
        retail_count: 0,
        vpc_stock_count: 0,
        unbuilt_count: 0,
        company_stock_count: 0,
        dealer_stock_count: 0,
        intransit_othervpc_count: 0,
        totalstock_count: 0,
        other_vpc_count: 0,
        postprocess_intransit_count: 0,
        preprocess_intransit_vpc_count: 0,
        wholesale_count: 0,
        hist_dealerstock_count: 0,
        hist_tmsstock_count: 0,
        hist_mfgstock_count: 0,
        hist_portstock_count: 0,
        hist_intransitstock_count: 0,
        sales_to_availability: 0
      };
    };

    // Create a copy of filters to avoid modifying the original request
    const filters = req.body.filters ? { ...req.body.filters } : null;

    // Convert all filter field values to uppercase if they are strings
    if (filters) {
      Object.keys(filters).forEach(key => {
        if (Array.isArray(filters[key])) {
          // Convert array values to uppercase if they are strings
          filters[key] = filters[key].map(value =>
            typeof value === 'string' ? value.toUpperCase() : value
          );
        } else if (typeof filters[key] === 'string') {
          // Convert single string values to uppercase
          filters[key] = filters[key].toUpperCase();
        }
        // Note: transaction_date object with gte/lte properties is left unchanged as dates should not be uppercased
      });
    }

    console.log('v51 filters:', JSON.stringify(filters));

    // Determine which index to use based on index_type
    const indexType = req.body.index_type;
    let indexName;
    const currentDate = new Date();
    const yearString = currentDate.getFullYear().toString();

    if (indexType == '0' || indexType == '1' || indexType == '2' || indexType == '3' || indexType == '4' || indexType == '5') {
      indexName = [`${ACCESSORY_INDEX}-${yearString}`];
    } else if (indexType == '6') {
      const previousYearString = (currentDate.getFullYear() - 1).toString();
      indexName = [`${ACCESSORY_INDEX}-${previousYearString}`];
    } else {
      if (filters && filters.sls_ccyymm && filters.sls_ccyymm.length > 0) {
        // Extract years from CCYYMM format (first 4 digits)
        const years = filters.sls_ccyymm.map(val => {
          const ccyymm = val.toString().padStart(6, '0');
          return parseInt(ccyymm.substring(0, 4));
        });

        const minYear = Math.min(...years);
        const maxYear = Math.max(...years);

        console.log(`V51 Min year: ${minYear}, Max year: ${maxYear}`);
        if (minYear === maxYear) {
          indexName = [`${ACCESSORY_INDEX}-${minYear}`];
        } else {
          indexName = [`${ACCESSORY_INDEX}-${minYear}`, `${ACCESSORY_INDEX}-${maxYear}`];
        }
      } else {
        // Default to current year index
        indexName = [`${ACCESSORY_INDEX}-${yearString}`];
      }
    }

    console.log('v51 index name:', indexName);

    // Execute query using the dealer aggregation service method
    const initialResult = await pipService.executeDealerAggregationQuery(
      filters || null,
      { page: 1, page_size: 10000 }, // Get a large page to apply filtering and sorting first
      indexName
    );

    console.log('v51 initialResult success:', initialResult.success);
    console.log('v51 initialResult data length:', initialResult.data ? initialResult.data.length : 0);

    if (!initialResult.success) {
      console.error('v51 query failed:', initialResult.error);
      return next(new Error(initialResult.error));
    }

    // Get aggregated data to apply inline filtering and sorting
    let aggregatedData = initialResult.data || [];
    console.log('v51 aggregatedData length:', aggregatedData.length);

    // Debug: Log sample of raw data from OpenSearch
    if (aggregatedData.length > 0) {
      console.log('v51 Sample raw data from OpenSearch:');
      aggregatedData.slice(0, 3).forEach((item, index) => {
        console.log(`Sample ${index}:`, JSON.stringify(item, null, 2));
      });
    }

    // Apply inline filtering if provided (on flat data before transformation)
    if (req.body.inlinefilter && Array.isArray(req.body.inlinefilter) && req.body.inlinefilter.length > 0) {
      console.log(`Applying ${req.body.inlinefilter.length} inline filters to v51 aggregated data`);

      aggregatedData = aggregatedData.filter(item => {
        return req.body.inlinefilter.every(filter => {
          // Use the applyDealerNameFilter function for enhanced dealer filtering
          if (filter.field === 'dealer_name' || filter.field === 'dealerCode' || filter.field === 'dealerName' || filter.field === 'dealer_code') {
            return applyDealerNameFilter(item, filter.field, filter.condition, filter.value);
          }
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
            default:
              return true;
          }
        });
      });

      console.log(`After v51 inline filtering, ${aggregatedData.length} items remain`);
    }

    // Transform flat data to dealer summary structure
    console.log('v51 transforming data to dealer summary format');
    let transformedResult;

    try {
      // Update the transformation function to calculate sales_to_availability
      const transformToDealerSummaryWithSales = (flatData) => {
        const originalResult = transformToDealerSummary(flatData);

        // Calculate sales_to_availability for each dealer
        originalResult.dealerSummary.dealers = originalResult.dealerSummary.dealers.map(dealer => {
          const retailCount = dealer.retail_count || 0;
          const dealerStockCount = dealer.dealer_stock_count || 0;
          const denominator = retailCount + dealerStockCount;
          dealer.sales_to_availability = denominator > 0 ? parseFloat((retailCount / denominator).toFixed(4)) : 0;
          return dealer;
        });

        // Calculate overall sales_to_availability for totals
        const totalRetailCount = originalResult.dealerSummary.totals.retail_count || 0;
        const totalDealerStockCount = originalResult.dealerSummary.totals.dealer_stock_count || 0;
        const totalDenominator = totalRetailCount + totalDealerStockCount;
        originalResult.dealerSummary.totals.sales_to_availability = totalDenominator > 0 ? parseFloat((totalRetailCount / totalDenominator).toFixed(4)) : 0;

        return originalResult;
      };

      transformedResult = transformToDealerSummaryWithSales(aggregatedData);
      console.log('v51 transformation complete, dealer count:', transformedResult.dealerSummary.count);

      // Validate the transformation result
      if (!transformedResult || !transformedResult.dealerSummary) {
        throw new Error('Invalid transformation result: missing dealerSummary');
      }

      if (!Array.isArray(transformedResult.dealerSummary.dealers)) {
        throw new Error('Invalid transformation result: dealers is not an array');
      }

    } catch (transformError) {
      console.error('v51 transformation failed:', transformError.message);
      return next(new Error(`Data transformation failed: ${transformError.message}`));
    }

    // Apply sorting to dealer-level data if provided
    if (req.body.sortfields && Array.isArray(req.body.sortfields) && req.body.sortfields.length > 0) {
      console.log(`Applying v51 sorting by ${req.body.sortfields.length} fields to dealer data`);

      transformedResult.dealerSummary.dealers.sort((a, b) => {
        for (const sort of req.body.sortfields) {
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

    // Apply pagination to dealer data
    const pagination = req.body.pagination || { page: 1, page_size: 100 };
    const totalDealers = transformedResult.dealerSummary.dealers.length;
    const startIndex = (pagination.page - 1) * pagination.page_size;
    const endIndex = startIndex + pagination.page_size;

    // Get paginated dealers
    const paginatedDealers = transformedResult.dealerSummary.dealers.slice(startIndex, endIndex);

    // Recalculate totals for paginated dealers only
    const paginatedTotals = getEmptyTotals();
    paginatedDealers.forEach(dealer => {
      Object.keys(paginatedTotals).forEach(field => {
        if (field !== 'sales_to_availability') {
          paginatedTotals[field] += (dealer[field] || 0);
        }
      });
    });

    // Calculate sales_to_availability for paginated totals
    const paginatedRetailCount = paginatedTotals.retail_count || 0;
    const paginatedDealerStockCount = paginatedTotals.dealer_stock_count || 0;
    const paginatedDenominator = paginatedRetailCount + paginatedDealerStockCount;
    paginatedTotals.sales_to_availability = paginatedDenominator > 0 ? parseFloat((paginatedRetailCount / paginatedDenominator).toFixed(4)) : 0;

    // Create final response with pagination - matching the required format
    const finalResponse = {
      data: {
        dealerSummary: {
          count: paginatedDealers.length,
          dealers: paginatedDealers,
          totals: paginatedTotals
        }
      },
      pagination: {
        current_page: pagination.page,
        page_size: paginatedDealers.length,
        total_pages: Math.ceil(totalDealers / pagination.page_size),
        has_next_page: endIndex < totalDealers,
        has_previous_page: startIndex > 0
      }
    };

    // Return the dealer summary structure with pagination
    console.log('v51 returning dealer summary structure with pagination');
    console.log(`Total dealers: ${totalDealers}, Paginated dealers: ${paginatedDealers.length}, Page: ${pagination.page}`);
    return res.json(finalResponse);

  } catch (error) {
    console.error('Error in POST /api/v51/pip/data:', error);
    next(error);
  }
});

// POST /api/dealer_color_summ/pip/data schema - New endpoint for dealer-level aggregation from color index
const postPipDataV52Schema = Joi.object({
  filters: Joi.object({
    region_code: Joi.array().items(Joi.string()).optional(),
    district_code: Joi.array().items(Joi.string()).optional(),
    dealer_code: Joi.array().items(Joi.string()).optional(),
    transaction_date: Joi.object({
      gte: Joi.string().optional().description('Start date (yyyy-MM-dd)'),
      lte: Joi.string().optional().description('End date (yyyy-MM-dd)')
    }).optional(),
    model_year: Joi.array().items(Joi.string()).optional(),
    model_code: Joi.array().items(Joi.string()).optional(),
    fleet_flag: Joi.array().items(Joi.boolean()).optional(),
    brand_code: Joi.array().items(Joi.string()).optional(),
    segment_code: Joi.array().items(Joi.string()).optional(),
    car_trk_indicator: Joi.array().items(Joi.string()).optional(),
    dealer_type: Joi.array().items(Joi.string()).optional(),
    team_lease_indicator: Joi.array().items(Joi.string()).optional(),
    transmissiontype_code: Joi.array().items(Joi.string()).optional(),
    series_name: Joi.array().items(Joi.string()).optional(),
    grade_code: Joi.array().items(Joi.string()).optional(),
    drivetrain_code: Joi.array().items(Joi.string()).optional(),
    napc_bu_code: Joi.array().items(Joi.string()).optional(),
    sls_ccyymm: Joi.array().items(Joi.string()).optional().description('Filter by year-month in CCYYMM format (e.g., "202407")'),
    exterior_color_code: Joi.array().items(Joi.string()).optional().description('Filter by exterior color codes'),
    interior_color_code: Joi.array().items(Joi.string()).optional().description('Filter by interior color codes')
  }).optional(),
  inlinefilter: Joi.array().items(
    Joi.object({
      field: Joi.string().valid(
        'sales_availability_count', 'days_supply_count', 'retail_count', 'vpc_stock_count',
        'unbuilt_count', 'company_stock_count', 'dealer_stock_count', 'intransit_othervpc_count',
        'totalstock_count', 'other_vpc_count', 'postprocess_intransit_count', 'preprocess_intransit_vpc_count',
        'wholesale_count', 'hist_dealerstock_count', 'hist_tmsstock_count', 'hist_mfgstock_count',
        'hist_portstock_count', 'hist_intransitstock_count'
      ).required(),
      condition: Joi.string().valid('>=', '<=', '=', '>', '<').required(),
      value: Joi.number().required()
    })
  ).optional().description('Inline filters to apply to dealer data after retrieval'),
  sortfields: Joi.array().items(
    Joi.object({
      field: Joi.string().valid(
        'sales_availability_count', 'days_supply_count', 'retail_count', 'vpc_stock_count',
        'unbuilt_count', 'company_stock_count', 'dealer_stock_count', 'intransit_othervpc_count',
        'totalstock_count', 'other_vpc_count', 'postprocess_intransit_count', 'preprocess_intransit_vpc_count',
        'wholesale_count', 'hist_dealerstock_count', 'hist_tmsstock_count', 'hist_mfgstock_count',
        'hist_portstock_count', 'hist_intransitstock_count', 'dealerCode', 'dealerName'
      ).required(),
      order: Joi.string().valid('asc', 'desc').required()
    })
  ).optional().description('Fields to sort dealer data by after retrieval'),
  pagination: Joi.object({
    page: Joi.number().integer().min(1).default(1),
    page_size: Joi.number().integer().min(1).max(3000).default(25)
  }).default({ page: 1, page_size: 10 }),
  index_type: Joi.string().valid('0', '1', '2', '3', '4', '5', '6', '7').default('currmth').description('Index type for date-based index selection')
});

// POST /api/dealer_color_summ/pip/data - Get dealer-level aggregated data from color index
router.post('/api/dealer_color_summ/pip/data', validateRequest({ body: postPipDataV52Schema }), async (req, res, next) => {
  try {
    console.log('entered the v52 function');
    console.log('v52 request body:', JSON.stringify(req.body, null, 2));
    const indexPar = req.query.index_par;
    logIndexPar('post_pip_data_v52', indexPar);

    // Inline transformation function for dealer summary from color data
    const transformToDealerSummary = (flatData) => {
      try {
        // Handle empty or invalid input
        if (!Array.isArray(flatData) || flatData.length === 0) {
          console.log('transformToDealerSummary: Empty or invalid input data');
          return {
            dealerSummary: {
              count: 0,
              dealers: [],
              totals: getEmptyTotals()
            }
          };
        }

        console.log(`transformToDealerSummary: Processing ${flatData.length} flat data items`);

        // Define all numeric fields that need aggregation
        const numericFields = [
          'sales_availability_count', 'days_supply_count', 'retail_count', 'vpc_stock_count',
          'unbuilt_count', 'company_stock_count', 'dealer_stock_count', 'intransit_othervpc_count',
          'totalstock_count', 'other_vpc_count', 'postprocess_intransit_count',
          'preprocess_intransit_vpc_count', 'wholesale_count', 'hist_dealerstock_count',
          'hist_tmsstock_count', 'hist_mfgstock_count', 'hist_portstock_count', 'hist_intransitstock_count'
        ];

        // Group data by dealer_code
        const dealerMap = new Map();
        const overallTotals = getEmptyTotals();

        flatData.forEach((item, index) => {
          try {
            if (!item || typeof item !== 'object') {
              console.warn(`transformToDealerSummary: Skipping invalid item at index ${index}:`, item);
              return;
            }

            const dealerCode = item.dealer_code || 'Unknown Dealer';
            const dealerName = item.dealer_name || 'Unknown Name';

            console.log(`Processing item ${index}: dealer=${dealerCode}, name=${dealerName}`);

            // Initialize dealer if not exists
            if (!dealerMap.has(dealerCode)) {
              console.log(`Creating new dealer: ${dealerCode}`);
              dealerMap.set(dealerCode, {
                dealerCode: dealerCode,
                dealerName: dealerName,
                brand_code: item.brand_code || null,
                region_code: item.region_code || '',
                region_name: item.region_name || '',
                district_code: item.district_code || '',
                // Preserve the rankings from the OpenSearch response
                national_ranking: item.national_ranking.rank || null,
                regional_ranking: item.regional_ranking.rank || null,
                ...getEmptyTotals()
              });
            }

            const dealer = dealerMap.get(dealerCode);

            // Process each numeric field and aggregate at dealer level
            numericFields.forEach(field => {
              let value = 0;

              // Handle different data types and null/undefined values
              if (item[field] !== null && item[field] !== undefined) {
                if (typeof item[field] === 'number') {
                  value = item[field];
                } else if (typeof item[field] === 'string') {
                  const parsed = parseInt(item[field]);
                  value = isNaN(parsed) ? 0 : parsed;
                }
              }

              // Add to dealer totals (this is the key aggregation step)
              const previousDealerValue = dealer[field];
              dealer[field] += value;

              // Add to overall totals
              overallTotals[field] += value;

              // Log aggregation for key fields
              if (field === 'sales_availability_count' || field === 'retail_count') {
                console.log(`${field}: item_value=${value}, dealer_before=${previousDealerValue}, dealer_after=${dealer[field]}`);
              }
            });

            console.log(`Updated dealer ${dealerCode} totals`);

          } catch (itemError) {
            console.error(`transformToDealerSummary: Error processing item at index ${index}:`, itemError.message);
            // Continue processing other items
          }
        });

        // Convert map to array and sort by dealer code
        const dealersArray = Array.from(dealerMap.values()).sort((a, b) =>
          a.dealerCode.localeCompare(b.dealerCode)
        );

        console.log(`transformToDealerSummary: Created ${dealersArray.length} dealers from ${flatData.length} total records`);

        // Validate overall totals
        const calculatedOverallTotal = dealersArray.reduce((sum, dealer) => sum + (dealer.sales_availability_count || 0), 0);
        console.log(`Overall totals validation: calculated=${calculatedOverallTotal}, stored=${overallTotals.sales_availability_count}`);

        const result = {
          dealerSummary: {
            count: dealersArray.length,
            dealers: dealersArray,
            totals: overallTotals
          }
        };

        // Validate the result structure
        if (!result.dealerSummary || !Array.isArray(result.dealerSummary.dealers)) {
          throw new Error('Invalid result structure created');
        }

        return result;

      } catch (error) {
        console.error('transformToDealerSummary: Transformation failed:', error.message);
        throw new Error(`Dealer summary transformation failed: ${error.message}`);
      }
    };

    // Helper function to get empty totals
    const getEmptyTotals = () => {
      return {
        sales_availability_count: 0,
        days_supply_count: 0,
        retail_count: 0,
        vpc_stock_count: 0,
        unbuilt_count: 0,
        company_stock_count: 0,
        dealer_stock_count: 0,
        intransit_othervpc_count: 0,
        totalstock_count: 0,
        other_vpc_count: 0,
        postprocess_intransit_count: 0,
        preprocess_intransit_vpc_count: 0,
        wholesale_count: 0,
        hist_dealerstock_count: 0,
        hist_tmsstock_count: 0,
        hist_mfgstock_count: 0,
        hist_portstock_count: 0,
        hist_intransitstock_count: 0,
        sales_to_availability: 0
      };
    };

    // Create a copy of filters to avoid modifying the original request
    const filters = req.body.filters ? { ...req.body.filters } : null;

    // Convert all filter field values to uppercase if they are strings
    if (filters) {
      Object.keys(filters).forEach(key => {
        if (Array.isArray(filters[key])) {
          // Convert array values to uppercase if they are strings
          filters[key] = filters[key].map(value =>
            typeof value === 'string' ? value.toUpperCase() : value
          );
        } else if (typeof filters[key] === 'string') {
          // Convert single string values to uppercase
          filters[key] = filters[key].toUpperCase();
        }
        // Note: transaction_date object with gte/lte properties is left unchanged as dates should not be uppercased
      });
    }

    console.log('v52 filters:', JSON.stringify(filters));

    // Determine which index to use based on index_type - using COLOR_INDEX for color data
    const indexType = req.body.index_type;
    let indexName;
    const currentDate = new Date();
    const yearString = currentDate.getFullYear().toString();

    if (indexType == '0' || indexType == '1' || indexType == '2' || indexType == '3' || indexType == '4' || indexType == '5') {
      indexName = [`${COLOR_INDEX}-${yearString}`];
    } else if (indexType == '6') {
      const previousYearString = (currentDate.getFullYear() - 1).toString();
      indexName = [`${COLOR_INDEX}-${previousYearString}`];
    } else {
      if (filters && filters.sls_ccyymm && filters.sls_ccyymm.length > 0) {
        // Extract years from CCYYMM format (first 4 digits)
        const years = filters.sls_ccyymm.map(val => {
          const ccyymm = val.toString().padStart(6, '0');
          return parseInt(ccyymm.substring(0, 4));
        });

        const minYear = Math.min(...years);
        const maxYear = Math.max(...years);

        console.log(`V52 Min year: ${minYear}, Max year: ${maxYear}`);
        if (minYear === maxYear) {
          indexName = [`${COLOR_INDEX}-${minYear}`];
        } else {
          indexName = [`${COLOR_INDEX}-${minYear}`, `${COLOR_INDEX}-${maxYear}`];
        }
      } else {
        // Default to current year index
        indexName = [`${COLOR_INDEX}-${yearString}`];
      }
    }

    console.log('v52 index name:', indexName);

    // Execute query using the color dealer aggregation service method
    const initialResult = await pipService.executeColorDealerAggregationQuery(
      filters || null,
      { page: 1, page_size: 10000 }, // Get a large page to apply filtering and sorting first
      indexName
    );

    console.log('v52 initialResult success:', initialResult.success);
    console.log('v52 initialResult data length:', initialResult.data ? initialResult.data.length : 0);

    if (!initialResult.success) {
      console.error('v52 query failed:', initialResult.error);
      return next(new Error(initialResult.error));
    }

    // Get aggregated data to apply inline filtering and sorting
    let aggregatedData = initialResult.data || [];
    console.log('v52 aggregatedData length:', aggregatedData.length);

    // Debug: Log sample of raw data from OpenSearch
    if (aggregatedData.length > 0) {
      console.log('v52 Sample raw data from OpenSearch:');
      aggregatedData.slice(0, 3).forEach((item, index) => {
        console.log(`Sample ${index}:`, JSON.stringify(item, null, 2));
        // Debug rankings specifically
        console.log(`Rankings for dealer ${item.dealer_code}:`, {
          national: item.national_ranking,
          regional: item.regional_ranking
        });
      });
    }

    // Apply inline filtering if provided (on flat data before transformation)
    if (req.body.inlinefilter && Array.isArray(req.body.inlinefilter) && req.body.inlinefilter.length > 0) {
      console.log(`Applying ${req.body.inlinefilter.length} inline filters to v52 aggregated data`);
      console.log(`aggregatedData ${JSON.stringify(aggregatedData)}`);
      aggregatedData = aggregatedData.filter(item => {
        return req.body.inlinefilter.every(filter => {
          const fieldValue = item[filter.field];

          // Use the applyDealerNameFilter function for enhanced dealer filtering
          if (filter.field === 'dealer_name' || filter.field === 'dealerCode' || filter.field === 'dealerName' || filter.field === 'dealer_code') {
            return applyDealerNameFilter(item, filter.field, filter.condition, filter.value);
          }

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
            default:
              return true;
          }
        });
      });
      console.log(`aggregatedDataAfterFilter ${JSON.stringify(aggregatedData)}`);
      console.log(`After v52 inline filtering, ${aggregatedData.length} items remain`);
    }

    // Transform flat data to dealer summary structure
    console.log('v52 transforming data to dealer summary format');
    let transformedResult;

    try {
      // Update the transformation function to calculate sales_to_availability
      const transformToDealerSummaryWithSales = (flatData) => {
        const originalResult = transformToDealerSummary(flatData);

        // Calculate sales_to_availability for each dealer
        originalResult.dealerSummary.dealers = originalResult.dealerSummary.dealers.map(dealer => {
          const retailCount = dealer.retail_count || 0;
          const dealerStockCount = dealer.dealer_stock_count || 0;
          const denominator = retailCount + dealerStockCount;
          dealer.sales_to_availability = denominator > 0 ? parseFloat((retailCount / denominator).toFixed(4)) : 0;

          // Ensure rankings are preserved during the transformation
          if (!dealer.national_ranking && dealer.national_ranking !== null) {
            console.log(`Missing national ranking for dealer ${dealer.dealerCode}`);
          }
          if (!dealer.regional_ranking && dealer.regional_ranking !== null) {
            console.log(`Missing regional ranking for dealer ${dealer.dealerCode}`);
          }

          return dealer;
        });

        // Calculate overall sales_to_availability for totals
        const totalRetailCount = originalResult.dealerSummary.totals.retail_count || 0;
        const totalDealerStockCount = originalResult.dealerSummary.totals.dealer_stock_count || 0;
        const totalDenominator = totalRetailCount + totalDealerStockCount;
        originalResult.dealerSummary.totals.sales_to_availability = totalDenominator > 0 ? parseFloat((totalRetailCount / totalDenominator).toFixed(4)) : 0;

        return originalResult;
      };

      transformedResult = transformToDealerSummaryWithSales(aggregatedData);
      console.log('v52 transformation complete, dealer count:', transformedResult.dealerSummary.count);
      console.log(`transformedResult ${JSON.stringify(transformedResult)}`);
      // Validate the transformation result
      if (!transformedResult || !transformedResult.dealerSummary) {
        throw new Error('Invalid transformation result: missing dealerSummary');
      }

      if (!Array.isArray(transformedResult.dealerSummary.dealers)) {
        throw new Error('Invalid transformation result: dealers is not an array');
      }

    } catch (transformError) {
      console.error('v52 transformation failed:', transformError.message);
      return next(new Error(`Data transformation failed: ${transformError.message}`));
    }

    // Apply sorting to dealer-level data if provided
    if (req.body.sortfields && Array.isArray(req.body.sortfields) && req.body.sortfields.length > 0) {
      console.log(`Applying v52 sorting by ${req.body.sortfields.length} fields to dealer data`);

      transformedResult.dealerSummary.dealers.sort((a, b) => {
        for (const sort of req.body.sortfields) {
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

    // Apply pagination to dealer data
    const pagination = req.body.pagination || { page: 1, page_size: 100 };
    const totalDealers = transformedResult.dealerSummary.dealers.length;
    const startIndex = (pagination.page - 1) * pagination.page_size;
    const endIndex = startIndex + pagination.page_size;

    // Get paginated dealers
    const paginatedDealers = transformedResult.dealerSummary.dealers.slice(startIndex, endIndex);

    // Recalculate totals for paginated dealers only
    const paginatedTotals = getEmptyTotals();
    paginatedDealers.forEach(dealer => {
      Object.keys(paginatedTotals).forEach(field => {
        if (field !== 'sales_to_availability') {
          paginatedTotals[field] += (dealer[field] || 0);
        }
      });
    });

    // Calculate sales_to_availability for paginated totals
    const paginatedRetailCount = paginatedTotals.retail_count || 0;
    const paginatedDealerStockCount = paginatedTotals.dealer_stock_count || 0;
    const paginatedDenominator = paginatedRetailCount + paginatedDealerStockCount;
    paginatedTotals.sales_to_availability = paginatedDenominator > 0 ? parseFloat((paginatedRetailCount / paginatedDenominator).toFixed(4)) : 0;
    console.log(`paginatedDealers ${JSON.stringify(paginatedDealers)}`);
    // Create final response with pagination - matching the required format
    const finalResponse = {
      data: {
        dealerSummary: {
          count: paginatedDealers.length,
          dealers: paginatedDealers.map(dealer => ({
            ...dealer
          })),
          totals: paginatedTotals
        }
      },
      pagination: {
        current_page: pagination.page,
        page_size: paginatedDealers.length,
        total_pages: Math.ceil(totalDealers / pagination.page_size),
        has_next_page: endIndex < totalDealers,
        has_previous_page: startIndex > 0
      }
    };

    // Return the dealer summary structure with pagination
    console.log('v52 returning dealer summary structure with pagination');
    console.log(`Total dealers: ${totalDealers}, Paginated dealers: ${paginatedDealers.length}, Page: ${pagination.page}`);
    return res.json(finalResponse);

  } catch (error) {
    console.error('Error in POST /api/v52/pip/data:', error);
    next(error);
  }
});

// POST /api/region-objective/pip/data schema - New endpoint for region objective data
const postRegionObjectiveSchema = Joi.object({
  filters: Joi.object({
    sls_ccyymm: Joi.array().items(Joi.string()).optional().description('Filter by year-month in CCYYMM format (e.g., "202407")'),
    business_month_key: Joi.array().items(Joi.string()).optional().description('Filter by business month key'),
    distributor_code: Joi.array().items(Joi.string()).optional().description('Filter by distributor codes'),
    region_code: Joi.array().items(Joi.string()).optional().description('Filter by region codes'),
    fleet_flag: Joi.array().items(Joi.boolean()).optional().description('Filter by fleet flag'),
    seg_type: Joi.array().items(Joi.string()).optional().description('Filter by segment type'),
    car_truck_indicator: Joi.array().items(Joi.string()).optional().description('Filter by car/truck indicator'),
    legacy_group_code: Joi.array().items(Joi.string()).optional().description('Filter by legacy group code'),
    legacy_group_type: Joi.array().items(Joi.string()).optional().description('Filter by legacy group type'),
    brand_code: Joi.array().items(Joi.string()).optional().description('Filter by brand code'),
    product_name: Joi.array().items(Joi.string()).optional().description('Filter by product name')
  }).optional(),
  inlinefilter: Joi.array().items(
    Joi.object({
      field: Joi.string().valid('region_code', 'retail_obj', 'wholesale_obj').required(),
      condition: Joi.string().valid('>=', '<=', '=', '>', '<').required(),
      value: Joi.number().required()
    })
  ).optional().description('Inline filters to apply to region data after retrieval'),
  sortfields: Joi.array().items(
    Joi.object({
      field: Joi.string().valid('region_code', 'retail_obj', 'wholesale_obj').required(),
      order: Joi.string().valid('asc', 'desc').required()
    })
  ).optional().description('Fields to sort region data by after retrieval'),
  pagination: Joi.object({
    page: Joi.number().integer().min(1).default(1),
    page_size: Joi.number().integer().min(1).max(3000).default(5)
  }).default({ page: 1, page_size: 5 }),
  index_type: Joi.string().valid('0', '1', '2', '3', '4', '5', '6', '7').default('currmth').description('Index type for date-based index selection')
});

// POST /api/region-objective/pip/data - Get region objective data
router.post('/api/region-objective/pip/data', validateRequest({ body: postRegionObjectiveSchema }), async (req, res, next) => {
  try {
    console.log('entered the region objective function');
    const indexPar = req.query.index_par;
    logIndexPar('post_region_objective_data', indexPar);

    // Create a copy of filters to avoid modifying the original request
    const filters = req.body.filters ? { ...req.body.filters } : null;
    console.log('region objective filters:', JSON.stringify(filters));

    // Determine which index to use based on index_type - using OBJECTIVE_INDEX for region objectives
    const indexType = req.body.index_type;
    let indexName;
    const currentDate = new Date();
    const yearString = currentDate.getFullYear().toString();

    if (indexType == '0' || indexType == '1' || indexType == '2' || indexType == '3' || indexType == '4' || indexType == '5') {
      indexName = [`${OBJECTIVE_INDEX}-${yearString}`];
    } else if (indexType == '6') {
      const previousYearString = (currentDate.getFullYear() - 1).toString();
      indexName = [`${OBJECTIVE_INDEX}-${previousYearString}`];
    } else {
      if (filters && filters.sls_ccyymm && filters.sls_ccyymm.length > 0) {
        // Extract years from CCYYMM format (first 4 digits)
        const years = filters.sls_ccyymm.map(val => {
          const ccyymm = val.toString().padStart(6, '0');
          return parseInt(ccyymm.substring(0, 4));
        });

        const minYear = Math.min(...years);
        const maxYear = Math.max(...years);

        console.log(`Region objective Min year: ${minYear}, Max year: ${maxYear}`);
        if (minYear === maxYear) {
          indexName = [`${OBJECTIVE_INDEX}-${minYear}`];
        } else {
          indexName = [`${OBJECTIVE_INDEX}-${minYear}`, `${OBJECTIVE_INDEX}-${maxYear}`];
        }
      } else {
        // Default to current year index
        indexName = [`${OBJECTIVE_INDEX}-${yearString}`];
      }
    }

    console.log('region objective index name:', indexName);



    // Execute query using the new region objective service method
    const initialResult = await pipService.executeRegionObjectiveQuery(
      filters || null,
      { page: 1, page_size: 10000 }, // Get a large page to apply filtering and sorting first
      indexName
    );

    console.log('region objective initialResult success:', initialResult.success);
    console.log('region objective initialResult data length:', initialResult.data ? initialResult.data.length : 0);

    if (!initialResult.success) {
      console.error('region objective query failed:', initialResult.error);
      return next(new Error(initialResult.error));
    }

    // Get region data to apply inline filtering and sorting
    let regionsData = initialResult.data || [];
    console.log('region objective regionsData length:', regionsData.length);

    // Debug: Log sample of raw data
    if (regionsData.length > 0) {
      console.log('region objective sample data:');
      regionsData.slice(0, 3).forEach((item, index) => {
        console.log(`Sample ${index}:`, JSON.stringify(item, null, 2));
      });
    }

    // Apply inline filtering if provided
    if (req.body.inlinefilter && Array.isArray(req.body.inlinefilter) && req.body.inlinefilter.length > 0) {
      console.log(`Applying ${req.body.inlinefilter.length} inline filters to region objective data`);

      regionsData = regionsData.filter(region => {
        return req.body.inlinefilter.every(filter => {
          const fieldValue = region[filter.field];

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
            default:
              return true;
          }
        });
      });

      console.log(`After region objective inline filtering, ${regionsData.length} regions remain`);
    }

    // Apply sorting if provided
    if (req.body.sortfields && Array.isArray(req.body.sortfields) && req.body.sortfields.length > 0) {
      console.log(`Applying region objective sorting by ${req.body.sortfields.length} fields`);

      regionsData.sort((a, b) => {
        for (const sort of req.body.sortfields) {
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

    // Calculate totals for all regions (before pagination)
    const totals = {
      retail_obj: regionsData.reduce((sum, region) => sum + (region.retail_obj || 0), 0),
      wholesale_obj: regionsData.reduce((sum, region) => sum + (region.wholesale_obj || 0), 0)
    };

    // Apply pagination to the filtered and sorted data
    const pagination = req.body.pagination || { page: 1, page_size: 5 };
    const totalRegions = regionsData.length;
    const startIndex = (pagination.page - 1) * pagination.page_size;
    const endIndex = startIndex + pagination.page_size;
    const paginatedRegions = regionsData.slice(startIndex, endIndex);

    // Create final response matching the required format
    const finalResponse = {
      data: {
        regionObjectiveSummary: {
          count: paginatedRegions.length,
          regions: paginatedRegions,
          totals: totals
        }
      },
      pagination: {
        current_page: pagination.page,
        page_size: pagination.page_size,
        total_pages: Math.ceil(totalRegions / pagination.page_size),
        has_next_page: endIndex < totalRegions,
        has_previous_page: startIndex > 0
      }
    };

    console.log('region objective returning final response');
    console.log(`Total regions: ${totalRegions}, Paginated regions: ${paginatedRegions.length}, Page: ${pagination.page}`);
    return res.json(finalResponse);

  } catch (error) {
    console.error('Error in POST /api/region-objective/pip/data:', error);
    next(error);
  }
});

// POST /api/series-objective/pip/data schema - New endpoint for series objective data
const postSeriesObjectiveSchema = Joi.object({
  filters: Joi.object({
    sls_ccyymm: Joi.array().items(Joi.string()).optional().description('Filter by year-month in CCYYMM format (e.g., "202407")'),
    business_month_key: Joi.array().items(Joi.string()).optional().description('Filter by business month key'),
    distributor_code: Joi.array().items(Joi.string()).optional().description('Filter by distributor codes'),
    region_code: Joi.array().items(Joi.string()).optional().description('Filter by region codes'),
    fleet_flag: Joi.array().items(Joi.boolean()).optional().description('Filter by fleet flag'),
    seg_type: Joi.array().items(Joi.string()).optional().description('Filter by segment type'),
    car_truck_indicator: Joi.array().items(Joi.string()).optional().description('Filter by car/truck indicator'),
    legacy_group_code: Joi.array().items(Joi.string()).optional().description('Filter by legacy group code'),
    brand_code: Joi.array().items(Joi.string()).optional().description('Filter by brand code'),
    product_name: Joi.array().items(Joi.string()).optional().description('Filter by product name')
  }).optional(),
  inlinefilter: Joi.array().items(
    Joi.object({
      field: Joi.string().valid('series_name', 'retail_obj', 'wholesale_obj').required(),
      condition: Joi.string().valid('>=', '<=', '=', '>', '<').required(),
      value: Joi.number().required()
    })
  ).optional().description('Inline filters to apply to series data after retrieval'),
  sortfields: Joi.array().items(
    Joi.object({
      field: Joi.string().valid('series_name', 'retail_obj', 'wholesale_obj').required(),
      order: Joi.string().valid('asc', 'desc').required()
    })
  ).optional().description('Fields to sort series data by after retrieval'),
  pagination: Joi.object({
    page: Joi.number().integer().min(1).default(1),
    page_size: Joi.number().integer().min(1).max(3000).default(5)
  }).default({ page: 1, page_size: 5 }),
  index_type: Joi.string().valid('0', '1', '2', '3', '4', '5', '6', '7').default('currmth').description('Index type for date-based index selection')
});

// POST /api/series-objective/pip/data - Get series objective data
router.post('/api/series-objective/pip/data', validateRequest({ body: postSeriesObjectiveSchema }), async (req, res, next) => {
  try {
    console.log('entered the series objective function');
    const indexPar = req.query.index_par;
    logIndexPar('post_series_objective_data', indexPar);

    // Create a copy of filters to avoid modifying the original request
    const filters = req.body.filters ? { ...req.body.filters } : null;
    console.log('series objective filters:', JSON.stringify(filters));

    // Determine which index to use based on index_type - using OBJECTIVE_INDEX for series objectives
    const indexType = req.body.index_type;
    let indexName;
    const currentDate = new Date();
    const yearString = currentDate.getFullYear().toString();

    if (indexType == '0' || indexType == '1' || indexType == '2' || indexType == '3' || indexType == '4' || indexType == '5') {
      indexName = [`${OBJECTIVE_INDEX}-${yearString}`];
    } else if (indexType == '6') {
      const previousYearString = (currentDate.getFullYear() - 1).toString();
      indexName = [`${OBJECTIVE_INDEX}-${previousYearString}`];
    } else {
      if (filters && filters.sls_ccyymm && filters.sls_ccyymm.length > 0) {
        // Extract years from CCYYMM format (first 4 digits)
        const years = filters.sls_ccyymm.map(val => {
          const ccyymm = val.toString().padStart(6, '0');
          return parseInt(ccyymm.substring(0, 4));
        });

        const minYear = Math.min(...years);
        const maxYear = Math.max(...years);

        console.log(`Series objective Min year: ${minYear}, Max year: ${maxYear}`);
        if (minYear === maxYear) {
          indexName = [`${OBJECTIVE_INDEX}-${minYear}`];
        } else {
          indexName = [`${OBJECTIVE_INDEX}-${minYear}`, `${OBJECTIVE_INDEX}-${maxYear}`];
        }
      } else {
        // Default to current year index
        indexName = [`${OBJECTIVE_INDEX}-${yearString}`];
      }
    }

    console.log('series objective index name:', indexName);

    // Execute query using the new series objective service method
    const initialResult = await pipService.executeSeriesObjectiveQuery(
      filters || null,
      { page: 1, page_size: 10000 }, // Get a large page to apply filtering and sorting first
      indexName
    );

    console.log('series objective initialResult success:', initialResult.success);
    console.log('series objective initialResult data length:', initialResult.data ? initialResult.data.length : 0);

    if (!initialResult.success) {
      console.error('series objective query failed:', initialResult.error);
      return next(new Error(initialResult.error));
    }

    // Get series data to apply inline filtering and sorting
    let seriesData = initialResult.data || [];
    console.log('series objective seriesData length:', seriesData.length);

    // Debug: Log sample of raw data
    if (seriesData.length > 0) {
      console.log('series objective sample data:');
      seriesData.slice(0, 3).forEach((item, index) => {
        console.log(`Sample ${index}:`, JSON.stringify(item, null, 2));
      });
    }

    // Apply inline filtering if provided
    if (req.body.inlinefilter && Array.isArray(req.body.inlinefilter) && req.body.inlinefilter.length > 0) {
      console.log(`Applying ${req.body.inlinefilter.length} inline filters to series objective data`);

      seriesData = seriesData.filter(series => {
        return req.body.inlinefilter.every(filter => {
          const fieldValue = series[filter.field];

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
            default:
              return true;
          }
        });
      });

      console.log(`After series objective inline filtering, ${seriesData.length} series remain`);
    }

    // Apply sorting if provided
    if (req.body.sortfields && Array.isArray(req.body.sortfields) && req.body.sortfields.length > 0) {
      console.log(`Applying series objective sorting by ${req.body.sortfields.length} fields`);

      seriesData.sort((a, b) => {
        for (const sort of req.body.sortfields) {
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

    // Calculate totals for all series (before pagination)
    const totals = {
      retail_obj: seriesData.reduce((sum, series) => sum + (series.retail_obj || 0), 0),
      wholesale_obj: seriesData.reduce((sum, series) => sum + (series.wholesale_obj || 0), 0)
    };

    // Apply pagination to the filtered and sorted data
    const pagination = req.body.pagination || { page: 1, page_size: 5 };
    const totalSeries = seriesData.length;
    const startIndex = (pagination.page - 1) * pagination.page_size;
    const endIndex = startIndex + pagination.page_size;
    const paginatedSeries = seriesData.slice(startIndex, endIndex);

    // Create final response matching the required format
    const finalResponse = {
      data: {
        seriesObjectiveSummary: {
          count: paginatedSeries.length,
          regions: paginatedSeries, // Note: keeping "regions" key as per your specification
          totals: totals
        }
      },
      pagination: {
        current_page: pagination.page,
        page_size: pagination.page_size,
        total_pages: Math.ceil(totalSeries / pagination.page_size),
        has_next_page: endIndex < totalSeries,
        has_previous_page: startIndex > 0
      }
    };

    console.log('series objective returning final response');
    console.log(`Total series: ${totalSeries}, Paginated series: ${paginatedSeries.length}, Page: ${pagination.page}`);
    return res.json(finalResponse);

  } catch (error) {
    console.error('Error in POST /api/series-objective/pip/data:', error);
    next(error);
  }
});
//Follow pipeline-routs for charts//
//KPI TILES
router.post('/api/kpitiles', validateRequest({ body: postChartSchema }), async (req, res, next) => {
  try {
    const { filters, indexName } = pipService.getRequestData(req, ACCESSORY_INDEX, SALES_INV_INDEX);
    // Create a copy of filters to avoid modifying the original request
    const modifiedFilter = req.body.filters ? { ...req.body.filters } : null;

    // Convert all filter field values to uppercase if they are strings
    if (modifiedFilter) {
      Object.keys(modifiedFilter).forEach(key => {
        if (Array.isArray(modifiedFilter[key])) {
          // Convert array values to uppercase if they are strings
          modifiedFilter[key] = modifiedFilter[key].map(value =>
            typeof value === 'string' ? value.toUpperCase() : value
          );
        } else if (typeof modifiedFilter[key] === 'string') {
          // Convert single string values to uppercase
          modifiedFilter[key] = modifiedFilter[key].toUpperCase();
        }
        // Note: transaction_date object with gte/lte properties is left unchanged as dates should not be uppercased
      });
    }
    console.log(`route modifiedFilter ${JSON.stringify(modifiedFilter)}`);
    const query = pipService.buildKpiTilesAggQuery(modifiedFilter || {});
    console.log(`route query ${JSON.stringify(query)}`);
    const client = await pipService.getClient();
    const response = await client.search({
      index: indexName || settings.indexNamesList,
      body: query,
      timeout: '30s'
    });
    const aggs = response.aggregations || response.body?.aggregations;
    console.log(`response ${JSON.stringify(aggs)}`);
    const kpiTiles = pipService.buildKpiTilesResponse(aggs);
    return res.json(kpiTiles);
  } catch (error) {
    return next(error);
  }
});
//Follow pipeline-routs for charts//
// POST /api/retailvehicle schema - Retail Vehicle Lookup API
const postRetailVehicleSchema = Joi.object({
  filters: Joi.object({
    region_code: Joi.array().items(Joi.string()).optional(),
    district_code: Joi.array().items(Joi.string()).optional(),
    dealer_code: Joi.array().items(Joi.string()).optional(),
    distributor_code: Joi.array().items(Joi.string()).optional(),
    model_year: Joi.array().items(Joi.string()).optional(),
    model_code: Joi.array().items(Joi.string()).optional(),
    fleet_flag: Joi.array().items(Joi.boolean()).optional(),
    brand_code: Joi.array().items(Joi.string()).optional(),
    segment_code: Joi.array().items(Joi.string()).optional(),
    car_trk_indicator: Joi.array().items(Joi.string()).optional(),
    dealer_type: Joi.array().items(Joi.string()).optional(),
    team_lease_indicator: Joi.array().items(Joi.boolean()).optional(),
    transmissiontype_code: Joi.array().items(Joi.string()).optional(),
    series_name: Joi.array().items(Joi.string()).optional(),
    grade_code: Joi.array().items(Joi.string()).optional(),
    // New v31 filter fields
    drivetrain_code: Joi.array().items(Joi.string()).optional(),
    accessory_code: Joi.array().items(Joi.string()).optional(),
    fac_pio_indicator: Joi.array().items(Joi.string()).optional(),
    napc_bu_code: Joi.array().items(Joi.string()).optional(),
    exterior_color_code: Joi.array().items(Joi.string()).optional(),
    interior_color_code: Joi.array().items(Joi.string()).optional(),
    sls_ccyymm: Joi.array().items(Joi.string()).optional().description('Filter by year-month in CCYYMM format (e.g., "202407")')
  }).optional().description('Global filters object'),
  inlinefilter: Joi.array().items(
    Joi.object({
      field: Joi.string().valid(
        'productionvin', 'modelyear', 'urn', 'brandcode', 'salesseriesname', 'modelcode',
        'vehiclelifecyclestatus', 'vehiclelifecyclestatuscode', 'ordernumber',
        'plantshortdescription', 'plantdescription', 'globalplantsourcecode',
        'distributorname', 'napcbucode', 'fleetindicator',
        'gradespeccode', 'modeldescription',
        'exteriorcolorcode', 'exteriorcolordescription', 'interiorcolordescription',
        'interiortrimcolorcode', 'interiortrimcolorname',
        'currentregionname', 'currentregioncode', 'currentdistrict',
        'currentdealername', 'currentdealercode',
        'retailregioncode', 'retailregionname', 'retaildealercode', 'retaildealername',
        'factoryaccessorycodes', 'ppoaccessorycodes', 'fioaccessories', 'ppoaccessories',
        'orderportentryDescription',
        'fdfleetdescription', 'fdfleet',
        'lifecyclesubstatusdescription',
        'dateoffirstuse', 'retailsalesbusinesssalesmonthfmt', 'rdrdate',
        'rdrreversaldate', 'businesssalesmonth', 'retaildate'
      ).required(),
      condition: Joi.string().valid('>=', '<=', '=', '>', '<', '!=', 'contains', 'not_contains').required(),
      value: Joi.alternatives().try(Joi.number(), Joi.string()).required()
    })
  ).optional().description('Inline filters to apply to vehicle data after retrieval'),
  pagination: Joi.object({
    page: Joi.number().integer().min(1).default(1),
    page_size: Joi.number().integer().min(1).max(3000).default(25)
  }).default({ page: 1, page_size: 25 }),
  sortfields: Joi.array().items(
    Joi.object({
      field: Joi.string().valid(
        'productionvin', 'modelyear', 'urn', 'brandcode', 'salesseriesname', 'modelcode',
        'vehiclelifecyclestatus', 'vehiclelifecyclestatuscode', 'ordernumber',
        'plantshortdescription', 'plantdescription', 'globalplantsourcecode',
        'distributorname', 'napcbucode', 'fleetindicator',
        'gradespeccode', 'modeldescription',
        'exteriorcolorcode', 'exteriorcolordescription', 'interiorcolordescription',
        'interiortrimcolorcode', 'interiortrimcolorname',
        'currentregionname', 'currentregioncode', 'currentdistrict',
        'currentdealername', 'currentdealercode',
        'retailregioncode', 'retailregionname', 'retaildealercode', 'retaildealername',
        'factoryaccessorycodes', 'ppoaccessorycodes', 'fioaccessories', 'ppoaccessories',
        'orderportentryDescription',
        'fdfleetdescription', 'fdfleet',
        'lifecyclesubstatusdescription',
        'dateoffirstuse', 'retailsalesbusinesssalesmonthfmt', 'rdrdate',
        'rdrreversaldate', 'businesssalesmonth', 'retaildate'
      ).required(),
      order: Joi.string().valid('asc', 'desc').required()
    })
  ).optional().description('Fields to sort vehicle data by'),
  index_type: Joi.string().valid('0', '1', '2', '3', '4', '5', '6', '7').default('currmth').description('Index type for date-based index selection')
});
//Follow pipeline-routs for retail vehilce//
//Retail Vehicle Lookup API
router.post('/api/retailvehicle', validateRequest({ body: postRetailVehicleSchema }), async (req, res, next) => {
  try {
    console.log('entered the retail vehicle lookup function');
    const indexPar = req.query.index_par;
    logIndexPar('post_retail_vehicle_lookup', indexPar);

    // Create a copy of filters to avoid modifying the original request
    const filters = req.body.filters ? { ...req.body.filters } : null;
    console.log('retail vehicle filters:', JSON.stringify(filters));

    // Convert all filter field values to uppercase if they are strings
    if (filters) {
      Object.keys(filters).forEach(key => {
        if (Array.isArray(filters[key])) {
          // Convert array values to uppercase if they are strings
          filters[key] = filters[key].map(value =>
            typeof value === 'string' ? value.toUpperCase() : value
          );
        } else if (typeof filters[key] === 'string') {
          // Convert single string values to uppercase
          filters[key] = filters[key].toUpperCase();
        }
        // Note: transaction_date object with gte/lte properties is left unchanged as dates should not be uppercased
      });
    }

    console.log('retail vehicle processed filters:', JSON.stringify(filters));
    // Determine which index to use based on index_type - using RETAIL_VEHICLE_INDEX for vehicle data
    const indexType = req.body.index_type;
    let indexName;
    const currentDate = new Date();
    const yearString = currentDate.getFullYear().toString();

    if (indexType == '0' || indexType == '1' || indexType == '2' || indexType == '3' || indexType == '4' || indexType == '5') {
      indexName = [`${RETAIL_VEHICLE_INDEX}-${yearString}`];
    } else if (indexType == '6') {
      const previousYearString = (currentDate.getFullYear() - 1).toString();
      indexName = [`${RETAIL_VEHICLE_INDEX}-${previousYearString}`];
    } else {
      // Default to current year if no specific index type
      indexName = [`${RETAIL_VEHICLE_INDEX}-${yearString}`];
    }

    console.log('retail vehicle index name:', indexName);

    // Execute query using the retail vehicle service method with inline filters and sorting
    const initialResult = await pipService.executeRetailVehicleLookupQuery(
      filters || null,
      req.body.pagination || { page: 1, page_size: 25 }, // Use actual pagination
      indexName,
      req.body.inlinefilter || null, // Pass inline filters to OpenSearch
      req.body.sortfields || null    // Pass sort fields to OpenSearch
    );

    console.log('retail vehicle initialResult success:', initialResult.success);
    console.log('retail vehicle initialResult data length:', initialResult.data ? initialResult.data.length : 0);


    if (!initialResult.success) {
      console.error('retail vehicle query failed:', initialResult.error);
      return next(new Error(initialResult.error));
    }

    // Get vehicle data (already filtered and sorted by OpenSearch)
    let vehicleData = initialResult.data || [];
    console.log('retail vehicle data length:', vehicleData.length);

    // Remove vehicle_vh_record_id field from each vehicle record
    const cleanedVehicles = vehicleData.map(vehicle => {
      const { vehicle_vh_record_id, ...cleanedVehicle } = vehicle;
      return cleanedVehicle;
    });

    // Use pagination info from the service response if available
    const totalVehicles = initialResult.total_count || vehicleData.length;
    const paginationInfo = initialResult.pagination || {
      current_page: req.body.pagination?.page || 1,
      page_size: req.body.pagination?.page_size || 25,
      total_pages: Math.ceil(totalVehicles / (req.body.pagination?.page_size || 25)),
      has_next: false,
      has_previous: false
    };

    // Validate that requested page doesn't exceed total pages
    if (paginationInfo.current_page > paginationInfo.total_pages && paginationInfo.total_pages > 0) {
      const error = new Error(`Invalid page number. Requested page ${paginationInfo.current_page} exceeds total pages ${paginationInfo.total_pages}.`);
      error.statusCode = 400;
      throw error;
    }

    // Create final response matching the required format
    const finalResponse = {
      data: {
        vehicleLookup: {
          count: cleanedVehicles.length,
          vehicles: cleanedVehicles,
          total_vehicles: totalVehicles
        }
      },
      pagination: {
        current_page: paginationInfo.current_page,
        page_size: paginationInfo.page_size,
        total_pages: paginationInfo.total_pages,
        has_next_page: paginationInfo.has_next || paginationInfo.has_next_page || false,
        has_previous_page: paginationInfo.has_previous || paginationInfo.has_previous_page || false
      }
    };

    // Add large dataset method information if it was used
    if (paginationInfo.large_dataset_method_used) {
      finalResponse.pagination.large_dataset_method_used = true;
      finalResponse.pagination.method_info = paginationInfo.method_info;
    }

    console.log('retail vehicle returning final response');
    console.log(`Total vehicles: ${totalVehicles}, Paginated vehicles: ${cleanedVehicles.length}, Page: ${paginationInfo.current_page}`);
    return res.json(finalResponse);

  } catch (error) {
    console.error('Error in POST /api/retailvehicle:', error);
    next(error);
  }
});
//Follow pipeline-routs for retail vehilce//
// POST /summary/bySeries-Color schema - New endpoint with series/model code structure including color filters and enhanced query logic
const postSeriesColorSummaryNewSchema = Joi.object({
  filters: Joi.object({
    // Core location filters
    region_code: Joi.array().items(Joi.string()).optional(),
    region_name: Joi.array().items(Joi.string()).optional(),
    district_code: Joi.array().items(Joi.string()).optional(),
    district_name: Joi.array().items(Joi.string()).optional(),
    dealer_code: Joi.array().items(Joi.string()).optional(),
    dealer_name: Joi.array().items(Joi.string()).optional(),
    dealer_group_name: Joi.array().items(Joi.string()).optional(),
    dealer_type: Joi.array().items(Joi.string()).optional(),

    // Distributor filters
    distributor_code: Joi.array().items(Joi.string()).optional(),

    // Date filters
    transaction_date: Joi.object({
      gte: Joi.string().optional().description('Start date (yyyy-MM-dd)'),
      lte: Joi.string().optional().description('End date (yyyy-MM-dd)')
    }).optional(),
    sls_ccyymm: Joi.array().items(Joi.string()).optional().description('Filter by year-month in CCYYMM format (e.g., "202407")'),

    // Vehicle filters
    vehicle_assignment_indicator: Joi.array().items(Joi.string()).optional(),
    model_year: Joi.array().items(Joi.string()).optional(),
    model_code: Joi.array().items(Joi.string()).optional(),
    fleet_flag: Joi.array().items(Joi.boolean()).optional(),
    fd_fleet_flag: Joi.array().items(Joi.boolean()).optional(),
    fd_fleet_description: Joi.array().items(Joi.string()).optional(),

    // Brand and segment filters
    brand_code: Joi.array().items(Joi.string()).optional(),
    segment_code: Joi.array().items(Joi.string()).optional(),
    subsegment_code: Joi.array().items(Joi.string()).optional(),

    // Vehicle characteristics
    car_trk_indicator: Joi.array().items(Joi.string()).optional(),
    team_lease_indicator: Joi.array().items(Joi.string()).optional(),
    team_member_lease_sale_type: Joi.array().items(Joi.string()).optional(),
    nap_cbu_code: Joi.array().items(Joi.string()).optional(),

    // Series and grade filters
    series_name: Joi.array().items(Joi.string()).optional(),
    series_display_order: Joi.array().items(Joi.string()).optional(),
    grade_code: Joi.array().items(Joi.string()).optional(),

    // Technical specifications
    transmissiontype_code: Joi.array().items(Joi.string()).optional(),
    drivetrain_code: Joi.array().items(Joi.string()).optional(),
    fueltype_code: Joi.array().items(Joi.string()).optional(),
    enginefueltype_code: Joi.array().items(Joi.string()).optional(),

    // Color filters
    exterior_color_code: Joi.array().items(Joi.string()).optional(),
    exterior_color_desc: Joi.array().items(Joi.string()).optional(),
    interior_color_code: Joi.array().items(Joi.string()).optional(),
    interior_trim_color_desc: Joi.array().items(Joi.string()).optional()
  }).optional(),

  inlinefilter: Joi.array().items(
    Joi.object({
      field: Joi.string().valid(
        // Text fields for contains filtering
        'series_name', 'region_name', 'brand_code', 'model_code', 'objective_available_indicator',
        // Numeric fields for comparison filtering
        'retail_count', 'wholesale_count', 'distributor_count', 'vpc_stock_count', 'unbuilt_count',
        'company_stock_count', 'dealer_stock_count', 'intransit_othervpc_count', 'totalstock_count',
        'other_vpc_count', 'postprocess_intransit_count', 'preprocess_intransit_vpc_count',
        'hist_dealerstock_count', 'hist_tmsstock_count', 'hist_mfgstock_count', 'hist_portstock_count',
        'hist_intransitstock_count', 'sales_to_availability', 'retail_objective_count',
        'retail_objective_percentage', 'wholesale_objective_count', 'wholesale_objective_percentage'
      ).required(),
      condition: Joi.string().valid('>=', '<=', '=', '>', '<', 'contains').required(),
      value: Joi.alternatives().try(Joi.number(), Joi.string(), Joi.array().items(Joi.string())).required()
    })
  ).optional().description('Inline filters to apply to aggregated data after retrieval'),

  sortfields: Joi.array().items(
    Joi.object({
      field: Joi.string().valid(
        'series_name', 'brand_code', 'model_code', 'objective_available_indicator', 'retail_count',
        'wholesale_count', 'distributor_count', 'vpc_stock_count', 'unbuilt_count', 'company_stock_count',
        'dealer_stock_count', 'intransit_othervpc_count', 'totalstock_count', 'other_vpc_count',
        'postprocess_intransit_count', 'preprocess_intransit_vpc_count', 'hist_dealerstock_count',
        'hist_tmsstock_count', 'hist_mfgstock_count', 'hist_portstock_count', 'hist_intransitstock_count',
        'sales_to_availability', 'retail_objective_count', 'retail_objective_percentage',
        'wholesale_objective_count', 'wholesale_objective_percentage'
      ).required(),
      order: Joi.string().valid('asc', 'desc').required()
    })
  ).optional().description('Fields to sort aggregated data by after retrieval'),

  pagination: Joi.object({
    page: Joi.number().integer().min(1).default(1),
    page_size: Joi.number().integer().min(1).max(3000).default(25)
  }).default({ page: 1, page_size: 10 }),

  index_type: Joi.string().valid('0', '1', '2', '3', '4', '5', '6', '7').default('0').description('Index type for query selection logic')
});

// POST /summary/bySeries-Color - New endpoint with series/model code structure and enhanced query logic
router.post('/summary/bySeries-Color', validateRequest({ body: postSeriesColorSummaryNewSchema }), async (req, res, next) => {
  try {
    console.log('entered the series_color_summary_new function');
    const indexPar = req.query.index_par;
    logIndexPar('post_series_color_summary_new', indexPar);

    // Get request parameters
    const filters = req.body.filters || null;
    const inlineFilters = req.body.inlinefilter || [];
    const sortFields = req.body.sortfields || [];
    const pagination = req.body.pagination || { page: 1, page_size: 10 };
    const indexType = req.body.index_type || '0';

    console.log('series_color_summary_new filters:', JSON.stringify(filters));
    console.log('series_color_summary_new inline filters:', JSON.stringify(inlineFilters));
    console.log('series_color_summary_new sort fields:', JSON.stringify(sortFields));
    console.log('series_color_summary_new index type:', indexType);

    // Convert filter values to uppercase for specified fields (excluding boolean fields)
    const processedFilters = filters ? { ...filters } : null;
    if (processedFilters) {
      const fieldsToCapitalize = [
        'distributor_code', 'region_code', 'region_name', 'dealer_code', 'dealer_name',
        'dealer_group_name', 'dealer_type', 'district_code', 'district_name',
        'vehicle_assignment_indicator', 'model_year', 'model_code', 'fd_fleet_description',
        'brand_code', 'segment_code', 'subsegment_code', 'team_member_lease_sale_type',
        'nap_cbu_code', 'series_name', 'series_display_order', 'grade_code',
        'transmissiontype_code', 'drivetrain_code', 'fueltype_code', 'enginefueltype_code',
        'exterior_color_code', 'exterior_color_desc', 'interior_color_code', 'interior_trim_color_desc'
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

    // Determine which index to use - for index types 0, 3, 5 use the color summary index
    let indexName;
    const currentDate = new Date();
    const yearString = currentDate.getFullYear().toString();

    if (['0', '3', '5'].includes(indexType)) {
      // Use the color summary index for these types
      indexName = [`pipe-rgn-dlr-dist-sale-color-current-summary-${yearString}`];
    } else if (indexType === '6') {
      const previousYearString = (currentDate.getFullYear() - 1).toString();
      indexName = [`pipe-rgn-dlr-dist-color-current-summary-${previousYearString}`];
    } else {
      if (processedFilters && processedFilters.sls_ccyymm && processedFilters.sls_ccyymm.length > 0) {
        // Extract years from CCYYMM format (first 4 digits)
        const years = processedFilters.sls_ccyymm.map(val => {
          const ccyymm = val.toString().padStart(6, '0');
          return parseInt(ccyymm.substring(0, 4));
        });

        const minYear = Math.min(...years);
        const maxYear = Math.max(...years);

        console.log(`series_color_summary_new Min year: ${minYear}, Max year: ${maxYear}`);
        if (minYear === maxYear) {
          indexName = [`pipe-rgn-dlr-dist-color-current-summary-${minYear}`];
        } else {
          indexName = [`pipe-rgn-dlr-dist-color-current-summary-${minYear}`, `pipe-rgn-dlr-dist-color-current-summary-${maxYear}`];
        }
      } else {
        // Default to current year index
        indexName = [`pipe-rgn-dlr-dist-color-current-summary-${yearString}`];
      }
    }

    console.log('series_color_summary_new index name:', indexName);

    // Execute query using the new series color summary service method
    const initialResult = await pipService.executeSeriesColorSummaryQuery(
      processedFilters,
      { page: 1, page_size: 50000 }, // Large page size for comprehensive results
      indexName,
      indexType,
      inlineFilters,
      sortFields
    );

    if (!initialResult.success) {
      return next(new Error(initialResult.error));
    }

    // Get aggregated data (already filtered and sorted by OpenSearch)
    let aggregatedData = initialResult.data || [];
    console.log(`series_color_summary_new Data count after OpenSearch processing: ${aggregatedData.length}`);

    // Debug: Log sample data to see what we're getting from the service
    if (aggregatedData.length > 0) {
      console.log('series_color_summary_new Sample data from service:', JSON.stringify(aggregatedData[0], null, 2));
    }

    // Transform data into series hierarchical structure
    const transformedData = transformToSeriesColorSummaryStructure(aggregatedData, indexType);

    // Filter out DUMMY series and model codes with 0000 from final response
    // Keep original totals (calculated from all data including DUMMY/0000)
    const originalTotals = { ...transformedData.seriesSummary.totals };

    const filteredSeries = transformedData.seriesSummary.series
      .filter(series => series.series_name !== 'DUMMY')
      .map(series => ({
        ...series,
        modelCodes: series.modelCodes.filter(model => model.model_code !== '0000')
      }));

    // Apply pagination at the series level (after filtering)
    const totalSeries = filteredSeries.length;
    const startIndex = (pagination.page - 1) * pagination.page_size;
    const endIndex = startIndex + pagination.page_size;

    // Get paginated series
    const paginatedSeries = filteredSeries.slice(startIndex, endIndex);

    // Recalculate totals for paginated series only
    const numericFields = [
      'sales_availability_count', 'days_supply_count', 'retail_count', 'wholesale_count',
      'distributor_count', 'vpc_stock_count', 'unbuilt_count', 'company_stock_count',
      'dealer_stock_count', 'intransit_othervpc_count', 'totalstock_count', 'other_vpc_count',
      'postprocess_intransit_count', 'preprocess_intransit_vpc_count', 'hist_dealerstock_count',
      'hist_tmsstock_count', 'hist_mfgstock_count', 'hist_portstock_count',
      'hist_intransitstock_count', 'sales_to_availability', 'retail_objective_count',
      'wholesale_objective_count'
    ];

    const paginatedTotals = {};
    numericFields.forEach(field => {
      paginatedTotals[field] = 0;
    });

    paginatedSeries.forEach(series => {
      numericFields.forEach(field => {
        paginatedTotals[field] += (series[field] || 0);
      });
    });

    // Calculate paginated totals percentages
    const paginatedRetailCount = paginatedTotals.retail_count || 0;
    const paginatedRetailObjective = paginatedTotals.retail_objective_count || 0;
    const paginatedWholesaleCount = paginatedTotals.wholesale_count || 0;
    const paginatedWholesaleObjective = paginatedTotals.wholesale_objective_count || 0;

    paginatedTotals.retail_objective_percentage = paginatedRetailObjective > 0
      ? parseFloat(((paginatedRetailCount / paginatedRetailObjective) * 100).toFixed(1))
      : 0;
    paginatedTotals.wholesale_objective_percentage = paginatedWholesaleObjective > 0
      ? parseFloat(((paginatedWholesaleCount / paginatedWholesaleObjective) * 100).toFixed(1))
      : 0;

    // Create pagination info
    const totalPages = Math.ceil(totalSeries / pagination.page_size);
    const updatedPaginationInfo = {
      current_page: pagination.page,
      page_size: paginatedSeries.length,
      total_pages: totalPages,
      has_next_page: endIndex < totalSeries,
      has_previous_page: startIndex > 0
    };

    // Prepare response with paginated series
    // Use original totals (includes DUMMY/0000 for calculations) but filtered series for display
    const result = {
      seriesSummary: {
        count: totalSeries,
        series: paginatedSeries,
        totals: originalTotals // Keep totals calculated from all data including DUMMY/0000
      },
      pagination: updatedPaginationInfo
    };

    console.log(`series_color_summary_new pagination: Total series: ${totalSeries}, Page: ${pagination.page}, Series in page: ${paginatedSeries.length}`);
    return res.json(result);
  } catch (error) {
    console.error('Error in POST /summary/bySeries-Color:', error);
    next(error);
  }
});

// POST /summary/bySeries-Accessory schema - New endpoint with series/model code structure including accessory filters and enhanced query logic
const postSeriesAccSummaryNewSchema = Joi.object({
  filters: Joi.object({
    // Core location filters
    region_code: Joi.array().items(Joi.string()).optional(),
    region_name: Joi.array().items(Joi.string()).optional(),
    district_code: Joi.array().items(Joi.string()).optional(),
    district_name: Joi.array().items(Joi.string()).optional(),
    dealer_code: Joi.array().items(Joi.string()).optional(),
    dealer_name: Joi.array().items(Joi.string()).optional(),
    dealer_group_name: Joi.array().items(Joi.string()).optional(),
    dealer_type: Joi.array().items(Joi.string()).optional(),

    // Distributor filters
    distributor_code: Joi.array().items(Joi.string()).optional(),

    // Date filters
    transaction_date: Joi.object({
      gte: Joi.string().optional().description('Start date (yyyy-MM-dd)'),
      lte: Joi.string().optional().description('End date (yyyy-MM-dd)')
    }).optional(),
    sls_ccyymm: Joi.array().items(Joi.string()).optional().description('Filter by year-month in CCYYMM format (e.g., "202407")'),

    // Vehicle filters
    vehicle_assignment_indicator: Joi.array().items(Joi.string()).optional(),
    model_year: Joi.array().items(Joi.string()).optional(),
    model_code: Joi.array().items(Joi.string()).optional(),
    fleet_flag: Joi.array().items(Joi.boolean()).optional(),
    fd_fleet_flag: Joi.array().items(Joi.boolean()).optional(),
    fd_fleet_description: Joi.array().items(Joi.string()).optional(),

    // Brand and segment filters
    brand_code: Joi.array().items(Joi.string()).optional(),
    segment_code: Joi.array().items(Joi.string()).optional(),
    subsegment_code: Joi.array().items(Joi.string()).optional(),

    // Vehicle characteristics
    car_trk_indicator: Joi.array().items(Joi.string()).optional(),
    team_lease_indicator: Joi.array().items(Joi.string()).optional(),
    team_member_lease_sale_type: Joi.array().items(Joi.string()).optional(),
    nap_cbu_code: Joi.array().items(Joi.string()).optional(),

    // Series and grade filters
    series_name: Joi.array().items(Joi.string()).optional(),
    series_display_order: Joi.array().items(Joi.string()).optional(),
    grade_code: Joi.array().items(Joi.string()).optional(),

    // Technical specifications
    transmissiontype_code: Joi.array().items(Joi.string()).optional(),
    drivetrain_code: Joi.array().items(Joi.string()).optional(),
    fueltype_code: Joi.array().items(Joi.string()).optional(),
    enginefueltype_code: Joi.array().items(Joi.string()).optional(),

    // Accessory filters (replacing color filters)
    fio_ppo_indicator: Joi.array().items(Joi.boolean()).optional(),
    accessory_code: Joi.array().items(Joi.string()).optional(),
    accessory_desc: Joi.array().items(Joi.string()).optional()
  }).optional(),

  inlinefilter: Joi.array().items(
    Joi.object({
      field: Joi.string().valid(
        // Text fields for contains filtering
        'series_name', 'region_name', 'brand_code', 'model_code', 'objective_available_indicator',
        // Numeric fields for comparison filtering
        'retail_count', 'wholesale_count', 'distributor_count', 'vpc_stock_count', 'unbuilt_count',
        'company_stock_count', 'dealer_stock_count', 'intransit_othervpc_count', 'totalstock_count',
        'other_vpc_count', 'postprocess_intransit_count', 'preprocess_intransit_vpc_count',
        'hist_dealerstock_count', 'hist_tmsstock_count', 'hist_mfgstock_count', 'hist_portstock_count',
        'hist_intransitstock_count', 'sales_to_availability', 'retail_objective_count',
        'retail_objective_percentage', 'wholesale_objective_count', 'wholesale_objective_percentage'
      ).required(),
      condition: Joi.string().valid('>=', '<=', '=', '>', '<', 'contains').required(),
      value: Joi.alternatives().try(Joi.number(), Joi.string(), Joi.array().items(Joi.string())).required()
    })
  ).optional().description('Inline filters to apply to aggregated data after retrieval'),

  sortfields: Joi.array().items(
    Joi.object({
      field: Joi.string().valid(
        'series_name', 'brand_code', 'model_code', 'objective_available_indicator', 'retail_count',
        'wholesale_count', 'distributor_count', 'vpc_stock_count', 'unbuilt_count', 'company_stock_count',
        'dealer_stock_count', 'intransit_othervpc_count', 'totalstock_count', 'other_vpc_count',
        'postprocess_intransit_count', 'preprocess_intransit_vpc_count', 'hist_dealerstock_count',
        'hist_tmsstock_count', 'hist_mfgstock_count', 'hist_portstock_count', 'hist_intransitstock_count',
        'sales_to_availability', 'retail_objective_count', 'retail_objective_percentage',
        'wholesale_objective_count', 'wholesale_objective_percentage'
      ).required(),
      order: Joi.string().valid('asc', 'desc').required()
    })
  ).optional().description('Fields to sort aggregated data by after retrieval'),

  pagination: Joi.object({
    page: Joi.number().integer().min(1).default(1),
    page_size: Joi.number().integer().min(1).max(3000).default(25)
  }).default({ page: 1, page_size: 10 }),

  index_type: Joi.string().valid('0', '1', '2', '3', '4', '5', '6', '7').default('0').description('Index type for query selection logic')
});

// POST /summary/bySeries-Accessory - New endpoint with series/model code structure and accessory query logic
router.post('/summary/bySeries-Accessory', validateRequest({ body: postSeriesAccSummaryNewSchema }), async (req, res, next) => {
  try {
    console.log('entered the series_acc_summary_new function');
    const indexPar = req.query.index_par;
    logIndexPar('post_series_acc_summary_new', indexPar);

    // Get request parameters
    const filters = req.body.filters || null;
    const inlineFilters = req.body.inlinefilter || [];
    const sortFields = req.body.sortfields || [];
    const pagination = req.body.pagination || { page: 1, page_size: 10 };
    const indexType = req.body.index_type || '0';

    console.log('series_acc_summary_new filters:', JSON.stringify(filters));
    console.log('series_acc_summary_new inline filters:', JSON.stringify(inlineFilters));
    console.log('series_acc_summary_new sort fields:', JSON.stringify(sortFields));
    console.log('series_acc_summary_new index type:', indexType);

    // Convert filter values to uppercase for specified fields (excluding boolean fields)
    const processedFilters = filters ? { ...filters } : null;
    if (processedFilters) {
      const fieldsToCapitalize = [
        'distributor_code', 'region_code', 'region_name', 'dealer_code', 'dealer_name',
        'dealer_group_name', 'dealer_type', 'district_code', 'district_name',
        'vehicle_assignment_indicator', 'model_year', 'model_code', 'fd_fleet_description',
        'brand_code', 'segment_code', 'subsegment_code', 'team_member_lease_sale_type',
        'nap_cbu_code', 'series_name', 'series_display_order', 'grade_code',
        'transmissiontype_code', 'drivetrain_code', 'fueltype_code', 'enginefueltype_code',
        // Accessory fields (replacing color fields)
        'fio_ppo_indicator', 'accessory_code', 'accessory_desc'
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

    // Determine which index to use - for index types 0, 3, 5 use the color summary index
    let indexName;
    const currentDate = new Date();
    const yearString = currentDate.getFullYear().toString();

    if (['0', '3', '5'].includes(indexType)) {
      // Use the accessory summary index for these types
      indexName = [`pipe-rgn-dlr-dist-sale-accessory-current-summary-${yearString}`];
    } else if (indexType === '6') {
      const previousYearString = (currentDate.getFullYear() - 1).toString();
      indexName = [`pipe-rgn-dlr-dist-sale-accessory-current-summary-${previousYearString}`];
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
          indexName = [`pipe-rgn-dlr-dist-sale-accessory-current-summary-${minYear}`];
        } else {
          indexName = [`pipe-rgn-dlr-dist-sale-accessory-current-summary-${minYear}`, `pipe-rgn-dlr-dist-sale-accessory-current-summary-${maxYear}`];
        }
      } else {
        // Default to current year index
        indexName = [`pipe-rgn-dlr-dist-sale-accessory-current-summary-${yearString}`];
      }
    }

    console.log('series_acc_summary_new index name:', indexName);

    // Execute query using the new series accessory summary service method
    const initialResult = await pipService.executeSeriesAccSummaryQuery(
      processedFilters,
      { page: 1, page_size: 50000 }, // Large page size for comprehensive results
      indexName,
      indexType,
      inlineFilters,
      sortFields
    );

    if (!initialResult.success) {
      return next(new Error(initialResult.error));
    }

    // Get aggregated data (already filtered and sorted by OpenSearch)
    let aggregatedData = initialResult.data || [];
    console.log(`series_acc_summary_new Data count after OpenSearch processing: ${aggregatedData.length}`);

    // Debug: Log sample data to see what we're getting from the service
    if (aggregatedData.length > 0) {
      console.log('series_acc_summary_new Sample data from service:', JSON.stringify(aggregatedData[0], null, 2));
    }

    // Transform data into series hierarchical structure
    const transformedData = transformToSeriesAccSummaryStructure(aggregatedData, indexType);

    // Filter out DUMMY series and model codes with 0000 from final response
    // Keep original totals (calculated from all data including DUMMY/0000)
    const originalTotals = { ...transformedData.seriesSummary.totals };

    const filteredSeries = transformedData.seriesSummary.series
      .filter(series => series.series_name !== 'DUMMY')
      .map(series => ({
        ...series,
        modelCodes: series.modelCodes.filter(model => model.model_code !== '0000')
      }));

    // Apply pagination at the series level (after filtering)
    const totalSeries = filteredSeries.length;
    const startIndex = (pagination.page - 1) * pagination.page_size;
    const endIndex = startIndex + pagination.page_size;

    // Get paginated series
    const paginatedSeries = filteredSeries.slice(startIndex, endIndex);

    // Recalculate totals for paginated series only
    const numericFields = [
      'sales_availability_count', 'days_supply_count', 'retail_count', 'wholesale_count',
      'distributor_count', 'vpc_stock_count', 'unbuilt_count', 'company_stock_count',
      'dealer_stock_count', 'intransit_othervpc_count', 'totalstock_count', 'other_vpc_count',
      'postprocess_intransit_count', 'preprocess_intransit_vpc_count', 'hist_dealerstock_count',
      'hist_tmsstock_count', 'hist_mfgstock_count', 'hist_portstock_count',
      'hist_intransitstock_count', 'sales_to_availability', 'retail_objective_count',
      'wholesale_objective_count'
    ];

    const paginatedTotals = {};
    numericFields.forEach(field => {
      paginatedTotals[field] = 0;
    });

    paginatedSeries.forEach(series => {
      numericFields.forEach(field => {
        paginatedTotals[field] += (series[field] || 0);
      });
    });

    // Calculate paginated totals percentages
    const paginatedRetailCount = paginatedTotals.retail_count || 0;
    const paginatedRetailObjective = paginatedTotals.retail_objective_count || 0;
    const paginatedWholesaleCount = paginatedTotals.wholesale_count || 0;
    const paginatedWholesaleObjective = paginatedTotals.wholesale_objective_count || 0;

    paginatedTotals.retail_objective_percentage = paginatedRetailObjective > 0
      ? parseFloat(((paginatedRetailCount / paginatedRetailObjective) * 100).toFixed(1))
      : 0;
    paginatedTotals.wholesale_objective_percentage = paginatedWholesaleObjective > 0
      ? parseFloat(((paginatedWholesaleCount / paginatedWholesaleObjective) * 100).toFixed(1))
      : 0;

    // Create pagination info
    const totalPages = Math.ceil(totalSeries / pagination.page_size);
    const updatedPaginationInfo = {
      current_page: pagination.page,
      page_size: paginatedSeries.length,
      total_pages: totalPages,
      has_next_page: endIndex < totalSeries,
      has_previous_page: startIndex > 0
    };

    // Prepare response with paginated series
    // Use original totals (includes DUMMY/0000 for calculations) but filtered series for display
    const result = {
      seriesSummary: {
        count: totalSeries,
        series: paginatedSeries,
        totals: originalTotals // Keep totals calculated from all data including DUMMY/0000
      },
      pagination: updatedPaginationInfo
    };

    console.log(`series_acc_summary_new pagination: Total series: ${totalSeries}, Page: ${pagination.page}, Series in page: ${paginatedSeries.length}`);
    return res.json(result);
  } catch (error) {
    console.error('Error in POST /summary/bySeries-Accessory:', error);
    next(error);
  }
});

/**
 * Transform flat data array into series-based hierarchical structure with model codes
 * @param {Array} flatData - Array of flat data objects
 * @param {string} indexType - Index type for query logic
 * @returns {Object} Hierarchical structure with seriesSummary
 */
const transformToSeriesColorSummaryStructure = (flatData, indexType) => {
  if (!Array.isArray(flatData) || flatData.length === 0) {
    return {
      seriesSummary: {
        count: 0,
        series: [],
        totals: {}
      }
    };
  }

  // Group data by series and model codes
  const seriesMap = new Map();
  const totals = {};

  // Define the numeric fields to aggregate
  const numericFields = [
    'sales_availability_count', 'days_supply_count', 'retail_count', 'wholesale_count',
    'distributor_count', 'vpc_stock_count', 'unbuilt_count', 'company_stock_count',
    'dealer_stock_count', 'intransit_othervpc_count', 'totalstock_count', 'other_vpc_count',
    'postprocess_intransit_count', 'preprocess_intransit_vpc_count', 'hist_dealerstock_count',
    'hist_tmsstock_count', 'hist_mfgstock_count', 'hist_portstock_count',
    'hist_intransitstock_count', 'sales_to_availability'
  ];

  // Initialize totals
  numericFields.forEach(field => {
    totals[field] = 0;
  });

  // Add objective fields to totals
  totals.retail_objective_count = 0;
  totals.retail_objective_percentage = 0;
  totals.wholesale_objective_count = 0;
  totals.wholesale_objective_percentage = 0;

  console.log(`transformToSeriesColorSummaryStructure: Processing ${flatData.length} items`);
  if (flatData.length > 0) {
    console.log('transformToSeriesColorSummaryStructure: Sample item:', JSON.stringify(flatData[0], null, 2));
  }

  flatData.forEach(item => {
    const seriesName = item.series_name || 'Unknown Series';
    const modelCode = item.model_code || 'Unknown Model';
    const brandCode = item.brand_code || null;

    // Initialize series if not exists
    if (!seriesMap.has(seriesName)) {
      const seriesData = {
        series_name: seriesName,
        brand_code: brandCode,
        objective_available_indicator: false,
        modelCodes: new Map()
      };

      // Initialize series totals
      numericFields.forEach(field => {
        seriesData[field] = 0;
      });

      // Initialize objective fields
      seriesData.retail_objective_count = 0;
      seriesData.retail_objective_percentage = 0;
      seriesData.wholesale_objective_count = 0;
      seriesData.wholesale_objective_percentage = 0;

      seriesMap.set(seriesName, seriesData);
    }

    const series = seriesMap.get(seriesName);

    // Initialize model code if not exists
    if (!series.modelCodes.has(modelCode)) {
      const modelData = {
        model_code: modelCode,
        brand_code: brandCode
      };

      // Initialize model totals
      numericFields.forEach(field => {
        modelData[field] = 0;
      });

      series.modelCodes.set(modelCode, modelData);
    }

    const model = series.modelCodes.get(modelCode);

    // Use the already processed values from the service method for all fields
    numericFields.forEach(field => {
      const value = parseInt(item[field]) || 0;
      model[field] = value; // Set directly since it's already processed
      series[field] += value;
      totals[field] += value;
    });

    // Set objectives (already processed by service)
    const retailObjective = parseInt(item.retail_objective_count) || 0;
    const wholesaleObjective = parseInt(item.wholesale_objective_count) || 0;

    model.retail_objective_count = retailObjective;
    model.wholesale_objective_count = wholesaleObjective;

    series.retail_objective_count += retailObjective;
    series.wholesale_objective_count += wholesaleObjective;
    totals.retail_objective_count += retailObjective;
    totals.wholesale_objective_count += wholesaleObjective;

    // Set objective available indicator
    if (retailObjective > 0 || wholesaleObjective > 0) {
      series.objective_available_indicator = true;
    }
  });

  // Convert maps to arrays and calculate percentages
  const series = Array.from(seriesMap.values()).map(seriesData => {
    // Extract modelCodes map and other fields separately
    const { modelCodes, ...seriesFields } = seriesData;

    // Calculate objective percentages for series
    if (seriesFields.retail_objective_count > 0) {
      seriesFields.retail_objective_percentage = parseFloat(
        ((seriesFields.retail_count / seriesFields.retail_objective_count) * 100).toFixed(1)
      );
    }

    if (seriesFields.wholesale_objective_count > 0) {
      seriesFields.wholesale_objective_percentage = parseFloat(
        ((seriesFields.wholesale_count / seriesFields.wholesale_objective_count) * 100).toFixed(1)
      );
    }

    return {
      ...seriesFields,
      modelCodes: Array.from(modelCodes.values())
    };
  });

  // Sort series by series_display_order if available, otherwise by series_name
  series.sort((a, b) => {
    // Default sort by series_name
    return a.series_name.localeCompare(b.series_name);
  });

  // Calculate overall objective percentages
  if (totals.retail_objective_count > 0) {
    totals.retail_objective_percentage = parseFloat(
      ((totals.retail_count / totals.retail_objective_count) * 100).toFixed(1)
    );
  }

  if (totals.wholesale_objective_count > 0) {
    totals.wholesale_objective_percentage = parseFloat(
      ((totals.wholesale_count / totals.wholesale_objective_count) * 100).toFixed(1)
    );
  }

  return {
    seriesSummary: {
      count: series.length,
      series: series,
      totals: totals
    }
  };
};

/**
 * Transform flat data array into series-based hierarchical structure with model codes for accessory endpoint
 * @param {Array} flatData - Array of flat data objects
 * @param {string} indexType - Index type for query logic
 * @returns {Object} Hierarchical structure with seriesSummary
 */
const transformToSeriesAccSummaryStructure = (flatData, indexType) => {
  if (!Array.isArray(flatData) || flatData.length === 0) {
    return {
      seriesSummary: {
        count: 0,
        series: [],
        totals: {}
      }
    };
  }

  // Group data by series and model codes
  const seriesMap = new Map();
  const totals = {};

  // Define the numeric fields to aggregate
  const numericFields = [
    'sales_availability_count', 'days_supply_count', 'retail_count', 'wholesale_count',
    'distributor_count', 'vpc_stock_count', 'unbuilt_count', 'company_stock_count',
    'dealer_stock_count', 'intransit_othervpc_count', 'totalstock_count', 'other_vpc_count',
    'postprocess_intransit_count', 'preprocess_intransit_vpc_count', 'hist_dealerstock_count',
    'hist_tmsstock_count', 'hist_mfgstock_count', 'hist_portstock_count',
    'hist_intransitstock_count', 'sales_to_availability'
  ];

  // Initialize totals
  numericFields.forEach(field => {
    totals[field] = 0;
  });

  // Add objective fields to totals
  totals.retail_objective_count = 0;
  totals.retail_objective_percentage = 0;
  totals.wholesale_objective_count = 0;
  totals.wholesale_objective_percentage = 0;

  console.log(`transformToSeriesAccSummaryStructure: Processing ${flatData.length} items`);
  if (flatData.length > 0) {
    console.log('transformToSeriesAccSummaryStructure: Sample item:', JSON.stringify(flatData[0], null, 2));
  }

  flatData.forEach(item => {
    const seriesName = item.series_name || 'Unknown Series';
    const modelCode = item.model_code || 'Unknown Model';
    const brandCode = item.brand_code || null;

    // Initialize series if not exists
    if (!seriesMap.has(seriesName)) {
      const seriesData = {
        series_name: seriesName,
        brand_code: brandCode,
        objective_available_indicator: false,
        modelCodes: new Map()
      };

      // Initialize series totals
      numericFields.forEach(field => {
        seriesData[field] = 0;
      });

      // Initialize objective fields
      seriesData.retail_objective_count = 0;
      seriesData.retail_objective_percentage = 0;
      seriesData.wholesale_objective_count = 0;
      seriesData.wholesale_objective_percentage = 0;

      seriesMap.set(seriesName, seriesData);
    }

    const series = seriesMap.get(seriesName);

    // Initialize model code if not exists
    if (!series.modelCodes.has(modelCode)) {
      const modelData = {
        model_code: modelCode,
        brand_code: brandCode
      };

      // Initialize model totals
      numericFields.forEach(field => {
        modelData[field] = 0;
      });

      series.modelCodes.set(modelCode, modelData);
    }

    const model = series.modelCodes.get(modelCode);

    // Use the already processed values from the service method for all fields
    numericFields.forEach(field => {
      const value = parseInt(item[field]) || 0;
      model[field] = value; // Set directly since it's already processed
      series[field] += value;
      totals[field] += value;
    });

    // Set objectives (already processed by service)
    const retailObjective = parseInt(item.retail_objective_count) || 0;
    const wholesaleObjective = parseInt(item.wholesale_objective_count) || 0;

    model.retail_objective_count = retailObjective;
    model.wholesale_objective_count = wholesaleObjective;

    series.retail_objective_count += retailObjective;
    series.wholesale_objective_count += wholesaleObjective;
    totals.retail_objective_count += retailObjective;
    totals.wholesale_objective_count += wholesaleObjective;

    // Set objective available indicator
    if (retailObjective > 0 || wholesaleObjective > 0) {
      series.objective_available_indicator = true;
    }
  });

  // Convert maps to arrays and calculate percentages
  const series = Array.from(seriesMap.values()).map(seriesData => {
    // Extract modelCodes map and other fields separately
    const { modelCodes, ...seriesFields } = seriesData;

    // Calculate objective percentages for series
    if (seriesFields.retail_objective_count > 0) {
      seriesFields.retail_objective_percentage = parseFloat(
        ((seriesFields.retail_count / seriesFields.retail_objective_count) * 100).toFixed(1)
      );
    }

    if (seriesFields.wholesale_objective_count > 0) {
      seriesFields.wholesale_objective_percentage = parseFloat(
        ((seriesFields.wholesale_count / seriesFields.wholesale_objective_count) * 100).toFixed(1)
      );
    }

    return {
      ...seriesFields,
      modelCodes: Array.from(modelCodes.values())
    };
  });

  // Sort series by series_display_order if available, otherwise by series_name
  series.sort((a, b) => {
    // Default sort by series_name
    return a.series_name.localeCompare(b.series_name);
  });

  // Calculate overall objective percentages
  if (totals.retail_objective_count > 0) {
    totals.retail_objective_percentage = parseFloat(
      ((totals.retail_count / totals.retail_objective_count) * 100).toFixed(1)
    );
  }

  if (totals.wholesale_objective_count > 0) {
    totals.wholesale_objective_percentage = parseFloat(
      ((totals.wholesale_count / totals.wholesale_objective_count) * 100).toFixed(1)
    );
  }

  return {
    seriesSummary: {
      count: series.length,
      series: series,
      totals: totals
    }
  };
};

// POST /summary/byDealer-Color schema - New dealer-focused endpoint with comprehensive filtering and sorting
const postDealerColorSummarySchema = Joi.object({
  filters: Joi.object({
    // Core location filters
    region_code: Joi.array().items(Joi.string()).optional(),
    region_name: Joi.array().items(Joi.string()).optional(),
    district_code: Joi.array().items(Joi.string()).optional(),
    district_name: Joi.array().items(Joi.string()).optional(),
    dealer_code: Joi.array().items(Joi.string()).optional(),
    dealer_name: Joi.array().items(Joi.string()).optional(),
    dealer_group_name: Joi.array().items(Joi.string()).optional(),
    dealer_type: Joi.array().items(Joi.string()).optional(),

    // Distributor filters
    distributor_code: Joi.array().items(Joi.string()).optional(),

    // Date filters
    transaction_date: Joi.object({
      gte: Joi.string().optional().description('Start date (yyyy-MM-dd)'),
      lte: Joi.string().optional().description('End date (yyyy-MM-dd)')
    }).optional(),
    sls_ccyymm: Joi.array().items(Joi.string()).optional().description('Filter by year-month in CCYYMM format (e.g., "202407")'),

    // Vehicle filters
    vehicle_assignment_indicator: Joi.array().items(Joi.string()).optional(),
    model_year: Joi.array().items(Joi.string()).optional(),
    model_code: Joi.array().items(Joi.string()).optional(),
    fleet_flag: Joi.array().items(Joi.boolean()).optional(),
    fd_fleet_flag: Joi.array().items(Joi.boolean()).optional(),
    fd_fleet_description: Joi.array().items(Joi.string()).optional(),

    // Brand and segment filters
    brand_code: Joi.array().items(Joi.string()).optional(),
    segment_code: Joi.array().items(Joi.string()).optional(),
    subsegment_code: Joi.array().items(Joi.string()).optional(),

    // Vehicle characteristics
    car_trk_indicator: Joi.array().items(Joi.boolean()).optional(),
    team_lease_indicator: Joi.array().items(Joi.string()).optional(),
    team_member_lease_sale_type: Joi.array().items(Joi.string()).optional(),
    nap_cbu_code: Joi.array().items(Joi.string()).optional(),

    // Series and grade filters
    series_name: Joi.array().items(Joi.string()).optional(),
    series_display_order: Joi.array().items(Joi.string()).optional(),
    grade_code: Joi.array().items(Joi.string()).optional(),

    // Technical specifications
    transmissiontype_code: Joi.array().items(Joi.string()).optional(),
    drivetrain_code: Joi.array().items(Joi.string()).optional(),
    fueltype_code: Joi.array().items(Joi.string()).optional(),
    enginefueltype_code: Joi.array().items(Joi.string()).optional(),

    // Color filters
    exterior_color_code: Joi.array().items(Joi.string()).optional(),
    exterior_color_desc: Joi.array().items(Joi.string()).optional(),
    interior_color_code: Joi.array().items(Joi.string()).optional(),
    interior_trim_color_desc: Joi.array().items(Joi.string()).optional()
  }).optional(),

  inlinefilter: Joi.array().items(
    Joi.object({
      field: Joi.string().valid(
        // Text fields for contains filtering
        'dealerCode', 'dealerName', 'brand_code', 'region_code', 'region_name', 'district_code', 'district_name',
        'vehicle_assignment_indicator',
        // Numeric fields for comparison filtering
        'national_ranking', 'regional_ranking', 'sales_availability_count', 'days_supply_count', 'retail_count',
        'wholesale_count', 'distributor_count', 'vpc_stock_count', 'unbuilt_count', 'company_stock_count',
        'dealer_stock_count', 'intransit_othervpc_count', 'totalstock_count', 'other_vpc_count',
        'postprocess_intransit_count', 'preprocess_intransit_vpc_count', 'hist_dealerstock_count',
        'hist_tmsstock_count', 'hist_mfgstock_count', 'hist_portstock_count', 'hist_intransitstock_count',
        'sales_to_availability'
      ).required(),
      condition: Joi.string().valid('>=', '<=', '=', '>', '<', 'contains').required(),
      value: Joi.alternatives().try(Joi.number(), Joi.string(), Joi.array().items(Joi.string())).required()
    })
  ).optional().description('Inline filters to apply to aggregated data after retrieval'),

  sortfields: Joi.array().items(
    Joi.object({
      field: Joi.string().valid(
        'dealerCode', 'dealerName', 'brand_code', 'region_code', 'region_name', 'district_code', 'district_name',
        'national_ranking', 'regional_ranking', 'sales_availability_count', 'days_supply_count', 'retail_count',
        'wholesale_count', 'distributor_count', 'vehicle_assignment_indicator', 'vpc_stock_count', 'unbuilt_count',
        'company_stock_count', 'dealer_stock_count', 'intransit_othervpc_count', 'totalstock_count',
        'other_vpc_count', 'postprocess_intransit_count', 'preprocess_intransit_vpc_count',
        'hist_dealerstock_count', 'hist_tmsstock_count', 'hist_mfgstock_count', 'hist_portstock_count',
        'hist_intransitstock_count', 'sales_to_availability'
      ).required(),
      order: Joi.string().valid('asc', 'desc').required()
    })
  ).optional().description('Fields to sort aggregated data by after retrieval'),

  pagination: Joi.object({
    page: Joi.number().integer().min(1).default(1),
    page_size: Joi.number().integer().min(1).max(3000).default(25)
  }).default({ page: 1, page_size: 10 }),

  index_type: Joi.string().valid('0', '3', '5').default('0').description('Index type for query selection logic (0=daily, 3=MTD, 5=YTD)')
});

// POST /summary/byDealer-Color - New dealer-focused endpoint with ranking and comprehensive data
router.post('/summary/byDealer-Color', validateRequest({ body: postDealerColorSummarySchema }), async (req, res, next) => {
  try {
    console.log('entered the dealer color summary function');
    const indexPar = req.query.index_par;
    logIndexPar('post_dealer_color_summary', indexPar);

    // Get request parameters
    const filters = req.body.filters || null;
    const inlineFilters = req.body.inlinefilter || [];
    const sortFields = req.body.sortfields || [];
    const pagination = req.body.pagination || { page: 1, page_size: 10 };
    const indexType = req.body.index_type || '0';

    console.log('dealer summary filters:', JSON.stringify(filters));
    console.log('dealer summary inline filters:', JSON.stringify(inlineFilters));
    console.log('dealer summary sort fields:', JSON.stringify(sortFields));
    console.log('dealer summary index type:', indexType);

    // Validate index_type for dealer endpoint (only 0, 3, 5 allowed)
    if (!['0', '3', '5'].includes(indexType)) {
      return res.status(400).json({
        error: 'Invalid index_type. Only 0 (daily), 3 (MTD), and 5 (YTD) are supported for dealer color summary.'
      });
    }

    // Determine index name - try current year first, then previous year if no data
    const currentDate = new Date();
    const currentYear = currentDate.getFullYear();
    const currentYearString = currentYear.toString();
    const previousYearString = (currentYear - 1).toString();

    // Try multiple possible index names
    const possibleIndices = [
      `pipe-rgn-dlr-dist-sale-color-current-summary-${currentYearString}`,
      `pipe-rgn-dlr-dist-sale-color-current-summary-${previousYearString}`,
      `pipe-rgn-dlr-dist-sale-color-current-summary-2024`,
      `pipe-rgn-dlr-dist-sale-color-current-summary-2023`
    ];

    let indexName = [possibleIndices[0]]; // Default to current year

    console.log('dealer summary possible indices:', possibleIndices);
    console.log('dealer summary using index:', indexName);

    // Execute dealer-focused query using the comprehensive method with rankings
    const dealerResult = await pipService.executeDealerColorSummaryQuery(
      filters,
      { page: 1, page_size: 50000 }, // Large page size for comprehensive results
      indexName,
      indexType,
      inlineFilters,
      sortFields
    );

    if (!dealerResult.success) {
      return next(new Error(dealerResult.error));
    }

    // Get the processed dealer data
    let dealerData = dealerResult.data || [];
    console.log(`Dealer summary data count: ${dealerData.length}`);

    // Debug: Log first few records if any exist
    if (dealerData.length > 0) {
      console.log('Sample dealer data:', JSON.stringify(dealerData.slice(0, 2), null, 2));
    } else {
      console.log('No dealer data returned. Checking result:', JSON.stringify(dealerResult, null, 2));
    }

    // Apply pagination
    const totalRecords = dealerData.length;
    const startIndex = (pagination.page - 1) * pagination.page_size;
    const endIndex = startIndex + pagination.page_size;
    const paginatedDealers = dealerData.slice(startIndex, endIndex);

    // Calculate totals for all dealers (before pagination)
    const numericFields = [
      'sales_availability_count', 'days_supply_count', 'retail_count', 'wholesale_count',
      'distributor_count', 'vpc_stock_count', 'unbuilt_count', 'company_stock_count',
      'dealer_stock_count', 'intransit_othervpc_count', 'totalstock_count', 'other_vpc_count',
      'postprocess_intransit_count', 'preprocess_intransit_vpc_count', 'hist_dealerstock_count',
      'hist_tmsstock_count', 'hist_mfgstock_count', 'hist_portstock_count',
      'hist_intransitstock_count', 'sales_to_availability'
    ];

    const totals = {};
    numericFields.forEach(field => {
      totals[field] = dealerData.reduce((sum, dealer) => sum + (dealer[field] || 0), 0);
    });

    // Create pagination info
    const totalPages = Math.ceil(totalRecords / pagination.page_size);
    const paginationInfo = {
      current_page: pagination.page,
      page_size: paginatedDealers.length,
      total_pages: totalPages,
      has_next_page: endIndex < totalRecords,
      has_previous_page: startIndex > 0
    };

    // Prepare response in the required format
    const result = {
      data: {
        dealerSummary: {
          count: totalRecords,
          dealers: paginatedDealers,
          totals: totals
        }
      },
      pagination: paginationInfo
    };

    console.log(`Dealer summary pagination: Total records: ${totalRecords}, Page: ${pagination.page}, Records in page: ${paginatedDealers.length}`);
    return res.json(result);
  } catch (error) {
    console.error('Error in POST /summary/byDealer-Color:', error);
    next(error);
  }
});

// POST /summary/byDealer-Accessory schema - New dealer-focused endpoint with accessory filtering and sorting
const postDealerAccSummarySchema = Joi.object({
  filters: Joi.object({
    // Core location filters
    region_code: Joi.array().items(Joi.string()).optional(),
    region_name: Joi.array().items(Joi.string()).optional(),
    district_code: Joi.array().items(Joi.string()).optional(),
    district_name: Joi.array().items(Joi.string()).optional(),
    dealer_code: Joi.array().items(Joi.string()).optional(),
    dealer_name: Joi.array().items(Joi.string()).optional(),
    dealer_group_name: Joi.array().items(Joi.string()).optional(),
    dealer_type: Joi.array().items(Joi.string()).optional(),

    // Distributor filters
    distributor_code: Joi.array().items(Joi.string()).optional(),

    // Date filters
    transaction_date: Joi.object({
      gte: Joi.string().optional().description('Start date (yyyy-MM-dd)'),
      lte: Joi.string().optional().description('End date (yyyy-MM-dd)')
    }).optional(),
    sls_ccyymm: Joi.array().items(Joi.string()).optional().description('Filter by year-month in CCYYMM format (e.g., "202407")'),

    // Vehicle filters
    vehicle_assignment_indicator: Joi.array().items(Joi.string()).optional(),
    model_year: Joi.array().items(Joi.string()).optional(),
    model_code: Joi.array().items(Joi.string()).optional(),
    fleet_flag: Joi.array().items(Joi.boolean()).optional(),
    fd_fleet_flag: Joi.array().items(Joi.boolean()).optional(),
    fd_fleet_description: Joi.array().items(Joi.string()).optional(),

    // Brand and segment filters
    brand_code: Joi.array().items(Joi.string()).optional(),
    segment_code: Joi.array().items(Joi.string()).optional(),
    subsegment_code: Joi.array().items(Joi.string()).optional(),

    // Vehicle characteristics
    car_trk_indicator: Joi.array().items(Joi.boolean()).optional(),
    team_lease_indicator: Joi.array().items(Joi.string()).optional(),
    team_member_lease_sale_type: Joi.array().items(Joi.string()).optional(),
    nap_cbu_code: Joi.array().items(Joi.string()).optional(),

    // Series and grade filters
    series_name: Joi.array().items(Joi.string()).optional(),
    series_display_order: Joi.array().items(Joi.string()).optional(),
    grade_code: Joi.array().items(Joi.string()).optional(),

    // Technical specifications
    transmissiontype_code: Joi.array().items(Joi.string()).optional(),
    drivetrain_code: Joi.array().items(Joi.string()).optional(),
    fueltype_code: Joi.array().items(Joi.string()).optional(),
    enginefueltype_code: Joi.array().items(Joi.string()).optional(),

    // Accessory filters (replacing color filters)
    fio_ppo_indicator: Joi.array().items(Joi.boolean()).optional(),
    accessory_code: Joi.array().items(Joi.string()).optional(),
    accessory_desc: Joi.array().items(Joi.string()).optional()
  }).optional(),

  inlinefilter: Joi.array().items(
    Joi.object({
      field: Joi.string().valid(
        // Text fields for contains filtering
        'dealerCode', 'dealerName', 'brand_code', 'region_code', 'region_name', 'district_code', 'district_name',
        'vehicle_assignment_indicator',
        // Numeric fields for comparison filtering
        'national_ranking', 'regional_ranking', 'sales_availability_count', 'days_supply_count', 'retail_count',
        'wholesale_count', 'distributor_count', 'vpc_stock_count', 'unbuilt_count', 'company_stock_count',
        'dealer_stock_count', 'intransit_othervpc_count', 'totalstock_count', 'other_vpc_count',
        'postprocess_intransit_count', 'preprocess_intransit_vpc_count', 'hist_dealerstock_count',
        'hist_tmsstock_count', 'hist_mfgstock_count', 'hist_portstock_count', 'hist_intransitstock_count',
        'sales_to_availability'
      ).required(),
      condition: Joi.string().valid('>=', '<=', '=', '>', '<', 'contains').required(),
      value: Joi.alternatives().try(Joi.number(), Joi.string(), Joi.array().items(Joi.string())).required()
    })
  ).optional().description('Inline filters to apply to aggregated data after retrieval'),

  sortfields: Joi.array().items(
    Joi.object({
      field: Joi.string().valid(
        'dealerCode', 'dealerName', 'brand_code', 'region_code', 'region_name', 'district_code', 'district_name',
        'national_ranking', 'regional_ranking', 'sales_availability_count', 'days_supply_count', 'retail_count',
        'wholesale_count', 'distributor_count', 'vehicle_assignment_indicator', 'vpc_stock_count', 'unbuilt_count',
        'company_stock_count', 'dealer_stock_count', 'intransit_othervpc_count', 'totalstock_count',
        'other_vpc_count', 'postprocess_intransit_count', 'preprocess_intransit_vpc_count',
        'hist_dealerstock_count', 'hist_tmsstock_count', 'hist_mfgstock_count', 'hist_portstock_count',
        'hist_intransitstock_count', 'sales_to_availability'
      ).required(),
      order: Joi.string().valid('asc', 'desc').required()
    })
  ).optional().description('Fields to sort aggregated data by after retrieval'),

  pagination: Joi.object({
    page: Joi.number().integer().min(1).default(1),
    page_size: Joi.number().integer().min(1).max(3000).default(25)
  }).default({ page: 1, page_size: 10 }),

  index_type: Joi.string().valid('0', '3', '5').default('0').description('Index type for query selection logic (0=daily, 3=MTD, 5=YTD)')
});

// POST /summary/byDealer-Accessory - New dealer-focused endpoint with accessory filtering, ranking and comprehensive data
router.post('/summary/byDealer-Accessory', validateRequest({ body: postDealerAccSummarySchema }), async (req, res, next) => {
  try {
    console.log('entered the dealer accessory summary function');
    const indexPar = req.query.index_par;
    logIndexPar('post_dealer_acc_summary', indexPar);

    // Get request parameters
    const filters = req.body.filters || null;
    const inlineFilters = req.body.inlinefilter || [];
    const sortFields = req.body.sortfields || [];
    const pagination = req.body.pagination || { page: 1, page_size: 10 };
    const indexType = req.body.index_type || '0';

    console.log('dealer accessory summary filters:', JSON.stringify(filters));
    console.log('dealer accessory summary inline filters:', JSON.stringify(inlineFilters));
    console.log('dealer accessory summary sort fields:', JSON.stringify(sortFields));
    console.log('dealer accessory summary index type:', indexType);

    // Validate index_type for dealer endpoint (only 0, 3, 5 allowed)
    if (!['0', '3', '5'].includes(indexType)) {
      return res.status(400).json({
        error: 'Invalid index_type. Only 0 (daily), 3 (MTD), and 5 (YTD) are supported for dealer accessory summary.'
      });
    }

    // Determine index name - try current year first, then previous year if no data
    const currentDate = new Date();
    const currentYear = currentDate.getFullYear();
    const currentYearString = currentYear.toString();
    const previousYearString = (currentYear - 1).toString();

    // Try multiple possible index names
    const possibleIndices = [
      `pipe-rgn-dlr-dist-sale-accessory-current-summary-${currentYearString}`,
      `pipe-rgn-dlr-dist-sale-accessory-current-summary-${previousYearString}`,
      `pipe-rgn-dlr-dist-sale-accessory-current-summary-2024`,
      `pipe-rgn-dlr-dist-sale-accessory-current-summary-2023`
    ];

    let indexName = [possibleIndices[0]]; // Default to current year

    console.log('dealer accessory summary possible indices:', possibleIndices);
    console.log('dealer accessory summary using index:', indexName);

    // Execute dealer-focused query using the comprehensive method with rankings
    const dealerResult = await pipService.executeDealerAccSummaryQuery(
      filters,
      { page: 1, page_size: 50000 }, // Large page size for comprehensive results
      indexName,
      indexType,
      inlineFilters,
      sortFields
    );

    if (!dealerResult.success) {
      return next(new Error(dealerResult.error));
    }

    // Get the processed dealer data
    let dealerData = dealerResult.data || [];
    console.log(`Dealer accessory summary data count: ${dealerData.length}`);

    // Debug: Log first few records if any exist
    if (dealerData.length > 0) {
      console.log('Sample dealer accessory data:', JSON.stringify(dealerData.slice(0, 2), null, 2));
    } else {
      console.log('No dealer accessory data returned. Checking result:', JSON.stringify(dealerResult, null, 2));
    }

    // Apply pagination
    const totalRecords = dealerData.length;
    const startIndex = (pagination.page - 1) * pagination.page_size;
    const endIndex = startIndex + pagination.page_size;
    const paginatedDealers = dealerData.slice(startIndex, endIndex);

    // Calculate totals for all dealers (before pagination)
    const numericFields = [
      'sales_availability_count', 'days_supply_count', 'retail_count', 'wholesale_count',
      'distributor_count', 'vpc_stock_count', 'unbuilt_count', 'company_stock_count',
      'dealer_stock_count', 'intransit_othervpc_count', 'totalstock_count', 'other_vpc_count',
      'postprocess_intransit_count', 'preprocess_intransit_vpc_count', 'hist_dealerstock_count',
      'hist_tmsstock_count', 'hist_mfgstock_count', 'hist_portstock_count',
      'hist_intransitstock_count', 'sales_to_availability'
    ];

    const totals = {};
    numericFields.forEach(field => {
      totals[field] = dealerData.reduce((sum, dealer) => sum + (dealer[field] || 0), 0);
    });

    // Create pagination info
    const totalPages = Math.ceil(totalRecords / pagination.page_size);
    const paginationInfo = {
      current_page: pagination.page,
      page_size: paginatedDealers.length,
      total_pages: totalPages,
      has_next_page: endIndex < totalRecords,
      has_previous_page: startIndex > 0
    };

    // Prepare response in the required format
    const result = {
      data: {
        dealerSummary: {
          count: totalRecords,
          dealers: paginatedDealers,
          totals: totals
        }
      },
      pagination: paginationInfo
    };

    console.log(`Dealer accessory summary pagination: Total records: ${totalRecords}, Page: ${pagination.page}, Records in page: ${paginatedDealers.length}`);
    return res.json(result);
  } catch (error) {
    console.error('Error in POST /summary/byDealer-Accessory:', error);
    next(error);
  }
});

// Debug endpoint to test index connectivity
router.get('/api/debug/dealer_index', async (req, res, next) => {
  try {
    const currentYear = new Date().getFullYear();
    const possibleIndices = [
      `pipe-rgn-dlr-dist-sale-color-current-summary-${currentYear}`,
      `pipe-rgn-dlr-dist-sale-color-current-summary-${currentYear - 1}`,
      `pipe-rgn-dlr-dist-sale-color-current-summary-2024`,
      `pipe-rgn-dlr-dist-sale-color-current-summary-2023`
    ];

    const client = await pipService.getClient();
    const results = [];

    for (const indexName of possibleIndices) {
      try {
        const existsResponse = await client.indices.exists({ index: indexName });
        if (existsResponse.body) {
          const countResponse = await client.count({ index: indexName });
          const sampleResponse = await client.search({
            index: indexName,
            body: { size: 1, query: { match_all: {} } }
          });

          results.push({
            index: indexName,
            exists: true,
            count: countResponse.body.count,
            sample: sampleResponse.body.hits.hits[0]?._source || null
          });
        } else {
          results.push({
            index: indexName,
            exists: false,
            count: 0,
            sample: null
          });
        }
      } catch (error) {
        results.push({
          index: indexName,
          exists: false,
          error: error.message,
          count: 0,
          sample: null
        });
      }
    }

    // Also try to list all available indices
    try {
      const catResponse = await client.cat.indices({ format: 'json' });
      const colorIndices = catResponse.body.filter(idx =>
        idx.index.includes('pipe-rgn-dlr-dist-sale-color') ||
        idx.index.includes('color')
      );

      return res.json({
        tested_indices: results,
        available_color_indices: colorIndices
      });
    } catch (catError) {
      return res.json({
        tested_indices: results,
        available_color_indices: [],
        cat_error: catError.message
      });
    }

  } catch (error) {
    console.error('Debug endpoint error:', error);
    return res.status(500).json({ error: error.message });
  }
});

//Modified API

// POST /summary/byRegion-Color - Enhanced endpoint with comprehensive filtering and sorting
router.post('/summary/modified/byRegion-Color', validateRequest({ body: postPipDataV33Schema }), async (req, res, next) => {
  try {
    console.log('entered the v33 enhanced function');

    // Helper function to convert string boolean values to actual booleans
    const convertToBoolean = (value) => {
      if (typeof value === 'boolean') return value;
      if (typeof value === 'string') return value.toUpperCase() === 'TRUE';
      return false;
    };

    const indexPar = req.query.index_par;
    logIndexPar('post_pip_data_v33', indexPar);

    // Get request parameters
    const filters = req.body.filters || null;
    const inlineFilters = req.body.inlinefilter || [];
    const sortFields = req.body.sortfields || [];
    const pagination = req.body.pagination || { page: 1, page_size: 10 };
    const indexType = req.body.index_type || '0';

    // Preprocess inline filters to convert boolean values to strings for OpenSearch compatibility
    const processedInlineFilters = inlineFilters.map(filter => {
      if (filter.field === 'objective_available_indicator' || filter.field === 'vehicle_assignment_indicator') {
        // Convert boolean values to string format expected by OpenSearch
        if (typeof filter.value === 'boolean') {
          return {
            ...filter,
            value: filter.value ? true : false
          };
        }
        // If it's already a string, ensure it's uppercase
        if (typeof filter.value === 'string') {
          return {
            ...filter,
            value: filter.value.toUpperCase()
          };
        }
      }
      return filter;
    });

    console.log('v33 filters:', JSON.stringify(filters));
    console.log('v33 inline filters:', JSON.stringify(inlineFilters));
    console.log('v33 processed inline filters:', JSON.stringify(processedInlineFilters));
    console.log('v33 sort fields:', JSON.stringify(sortFields));
    console.log('v33 index type:', indexType);

    // Determine which index to use - for index types 0, 3, 5 use the color summary index
    let indexName;
    const currentDate = new Date();
    const yearString = currentDate.getFullYear().toString();

    if (['0', '3', '5'].includes(indexType)) {
      // Use the color summary index for these types
      indexName = [`pipe-rgn-dlr-dist-sale-color-current-summary-${yearString}`];
    } else if (indexType === '6') {
      const previousYearString = (currentDate.getFullYear() - 1).toString();
      indexName = [`pipe-rgn-dlr-dist-sale-color-current-summary-${previousYearString}`];
    } else {
      if (filters && filters.sls_ccyymm && filters.sls_ccyymm.length > 0) {
        // Extract years from CCYYMM format (first 4 digits)
        const years = filters.sls_ccyymm.map(val => {
          const ccyymm = val.toString().padStart(6, '0');
          return parseInt(ccyymm.substring(0, 4));
        });

        const minYear = Math.min(...years);
        const maxYear = Math.max(...years);

        console.log(`V33 Min year: ${minYear}, Max year: ${maxYear}`);
        if (minYear === maxYear) {
          indexName = [`pipe-rgn-dlr-dist-sale-color-current-summary-${minYear}`];
        } else {
          indexName = [`pipe-rgn-dlr-dist-sale-color-current-summary-${minYear}`, `pipe-rgn-dlr-dist-sale-color-current-summary-${maxYear}`];
        }
      } else {
        // Default to current year index
        indexName = [`pipe-rgn-dlr-dist-sale-color-current-summary-${yearString}`];
      }
    }

    console.log('v33 index name:', indexName);

    // Execute enhanced query using the new v33 service method with OpenSearch-based filtering and sorting
    const initialResult = await pipService.ModifiedexecutePaginatedQueryV33(
      filters,
      { page: 1, page_size: 50000 }, // Large page size for comprehensive results
      indexName,
      indexType,
      processedInlineFilters, // Pass processed inline filters to OpenSearch
      sortFields     // Pass sort fields to OpenSearch
    );

    if (!initialResult.success) {
      return next(new Error(initialResult.error));
    }

    // Get aggregated data (already filtered and sorted by OpenSearch)
    let aggregatedData = initialResult.data || [];
    console.log(`V33 Data count after OpenSearch processing: ${aggregatedData.length}`);

    // Transform data into enhanced hierarchical structure first
    const transformedData = pipService._transformToHierarchicalStructureV33(aggregatedData, pagination);

    // Apply pagination at the region level
    const totalRegions = transformedData.regionSummary.regions.length;
    const startIndex = (pagination.page - 1) * pagination.page_size;
    const endIndex = startIndex + pagination.page_size;

    // Get paginated regions
    const paginatedRegions = transformedData.regionSummary.regions.slice(startIndex, endIndex);

    // Recalculate totals for paginated regions only
    const numericFields = [
      'sales_availability_count', 'days_supply_count', 'retail_count', 'vpc_stock_count',
      'unbuilt_count', 'company_stock_count', 'dealer_stock_count', 'intransit_othervpc_count',
      'totalstock_count', 'other_vpc_count', 'postprocess_intransit_count', 'preprocess_intransit_vpc_count',
      'wholesale_count', 'hist_dealerstock_count', 'hist_tmsstock_count', 'hist_mfgstock_count',
      'hist_portstock_count', 'hist_intransitstock_count', 'distributor_count', 'retail_objective_count',
      'wholesale_objective_count', 'dealer_retail_obj', 'series_retail_ytd_obj', 'series_wholesale_ytd_obj',
      'region_retail_ytd_obj', 'region_wholesale_ytd_obj'
    ];

    const paginatedTotals = {};
    numericFields.forEach(field => {
      paginatedTotals[field] = 0;
    });

    paginatedRegions.forEach(region => {
      numericFields.forEach(field => {
        paginatedTotals[field] += (region[field] || 0);
      });
    });

    // Calculate paginated totals percentages
    const paginatedRetailCount = paginatedTotals.retail_count || 0;
    const paginatedRetailObjective = paginatedTotals.retail_objective_count || 0;
    const paginatedWholesaleCount = paginatedTotals.wholesale_count || 0;
    const paginatedWholesaleObjective = paginatedTotals.wholesale_objective_count || 0;
    const paginatedDealerStockCount = paginatedTotals.dealer_stock_count || 0;

    paginatedTotals.retail_objective_percentage = paginatedRetailObjective > 0
      ? parseFloat(((paginatedRetailCount / paginatedRetailObjective) * 100).toFixed(2))
      : 0;
    paginatedTotals.wholesale_objective_percentage = paginatedWholesaleObjective > 0
      ? parseFloat(((paginatedWholesaleCount / paginatedWholesaleObjective) * 100).toFixed(2))
      : 0;

    // Always set sales_to_availability to 0 as per requirement
    paginatedTotals.sales_to_availability = 0;

    // Filter response to include only required fields
    const filterResponseFields = (obj, level) => {
      // Base fields that are common to all levels
      const commonFields = ['sales_availability_count', 'days_supply_count', 'retail_count', 'wholesale_count',
        'distributor_count', 'vpc_stock_count', 'unbuilt_count', 'company_stock_count',
        'dealer_stock_count', 'intransit_othervpc_count', 'totalstock_count', 'other_vpc_count',
        'postprocess_intransit_count', 'preprocess_intransit_vpc_count', 'hist_dealerstock_count',
        'hist_tmsstock_count', 'hist_mfgstock_count', 'hist_portstock_count',
        'hist_intransitstock_count', 'sales_to_availability'];

      // Objective fields that should only exist at region level
      const regionOnlyFields = ['retail_objective_count', 'retail_objective_percentage',
        'wholesale_objective_count', 'wholesale_objective_percentage'];

      const filtered = {};

      if (level === 'region') {
        filtered.region_code = obj.region_code;
        filtered.region_name = obj.region_name;
        filtered.brand_code = obj.brand_code;
        filtered.objective_available_indicator = obj.objective_available_indicator;
        // Note: region_display_order is excluded from response as it's only used for sorting

        // Add all fields including objective fields for regions
        [...commonFields, ...regionOnlyFields].forEach(field => {
          filtered[field] = obj[field] || 0;
        });
      } else if (level === 'district') {
        filtered.district_code = obj.district_code;
        filtered.district_name = obj.district_name;
        filtered.brand_code = obj.brand_code;
        filtered.vehicle_assignment_indicator = obj.vehicle_assignment_indicator;

        // Add only common fields (exclude objective fields for districts)
        commonFields.forEach(field => {
          filtered[field] = obj[field] || 0;
        });
      } else if (level === 'dealer') {
        filtered.dealer_code = obj.dealer_code;
        filtered.dealer_name = obj.dealer_name;
        filtered.brand_code = obj.brand_code;
        filtered.vehicle_assignment_indicator = obj.vehicle_assignment_indicator;

        // Add only common fields (exclude objective fields for dealers)
        commonFields.forEach(field => {
          filtered[field] = obj[field] || 0;
        });
      }

      return filtered;
    };

    // Filter paginated regions
    const filteredRegions = paginatedRegions.map(region => {
      const filteredRegion = filterResponseFields(region, 'region');
      filteredRegion.districts = region.districts.map(district => {
        const filteredDistrict = filterResponseFields(district, 'district');
        filteredDistrict.dealers = district.dealers.map(dealer =>
          filterResponseFields(dealer, 'dealer')
        );
        return filteredDistrict;
      });
      return filteredRegion;
    });

    // Filter totals to include only required fields
    const filteredTotals = {};
    const totalFields = ['sales_availability_count', 'days_supply_count', 'retail_count', 'wholesale_count',
      'distributor_count', 'retail_objective_count', 'retail_objective_percentage',
      'wholesale_objective_count', 'wholesale_objective_percentage', 'vpc_stock_count',
      'unbuilt_count', 'company_stock_count', 'dealer_stock_count', 'intransit_othervpc_count',
      'totalstock_count', 'other_vpc_count', 'postprocess_intransit_count',
      'preprocess_intransit_vpc_count', 'hist_dealerstock_count', 'hist_tmsstock_count',
      'hist_mfgstock_count', 'hist_portstock_count', 'hist_intransitstock_count', 'sales_to_availability'];

    totalFields.forEach(field => {
      filteredTotals[field] = paginatedTotals[field] || 0;
    });

    // Create pagination info without total_regions
    const totalPages = Math.ceil(totalRegions / pagination.page_size);
    const updatedPaginationInfo = {
      current_page: pagination.page,
      page_size: filteredRegions.length,
      total_pages: totalPages,
      has_next_page: endIndex < totalRegions,
      has_previous_page: startIndex > 0
    };

    // Calculate count as the total number of regions before pagination
    const correctCount = totalRegions;

    // Prepare enhanced response with filtered regions
    const result = {
      data: {
        regionSummary: {
          count: correctCount,
          regions: filteredRegions,
          totals: filteredTotals
        }
      },
      pagination: updatedPaginationInfo
    };

    // Convert boolean fields in the filtered regions
    result.data.regionSummary.regions.forEach(region => {
      if (region.objective_available_indicator !== undefined) {
        region.objective_available_indicator = convertToBoolean(region.objective_available_indicator);
      }

      region.districts.forEach(district => {
        if (district.vehicle_assignment_indicator !== undefined) {
          district.vehicle_assignment_indicator = convertToBoolean(district.vehicle_assignment_indicator);
        }

        district.dealers.forEach(dealer => {
          if (dealer.vehicle_assignment_indicator !== undefined) {
            dealer.vehicle_assignment_indicator = convertToBoolean(dealer.vehicle_assignment_indicator);
          }
        });
      });
    });

    console.log(`V33 pagination: Total regions: ${totalRegions}, Page: ${pagination.page}, Regions in page: ${paginatedRegions.length}`);
    return res.json(result);
  } catch (error) {
    console.error('Error in POST /summary/byRegion-Color:', error);
    next(error);
  }
});


// POST /summary/byRegion-Accessory - Enhanced endpoint with accessory filtering and sorting
router.post('/summary/modified/byRegion-Accessory', validateRequest({ body: postPipDataV34Schema }), async (req, res, next) => {
  try {
    console.log('entered the v34 accessory enhanced function');

    // Helper function to convert string boolean values to actual booleans
    const convertToBoolean = (value) => {
      if (typeof value === 'boolean') return value;
      if (typeof value === 'string') return value.toUpperCase() === 'TRUE';
      return false;
    };

    const indexPar = req.query.index_par;
    logIndexPar('post_pip_data_v34', indexPar);

    // Get request parameters
    const filters = req.body.filters || null;
    const inlineFilters = req.body.inlinefilter || [];
    const sortFields = req.body.sortfields || [];
    const pagination = req.body.pagination || { page: 1, page_size: 10 };
    const indexType = req.body.index_type || '0';

    // Preprocess inline filters to convert boolean values to strings for OpenSearch compatibility
    const processedInlineFilters = inlineFilters.map(filter => {
      if (filter.field === 'objective_available_indicator' || filter.field === 'vehicle_assignment_indicator') {
        // Convert boolean values to string format expected by OpenSearch
        if (typeof filter.value === 'boolean') {
          return {
            ...filter,
            value: filter.value ? true : false
          };
        }
        // If it's already a string, ensure it's uppercase
        if (typeof filter.value === 'string') {
          return {
            ...filter,
            value: filter.value.toUpperCase()
          };
        }
      }
      return filter;
    });

    console.log('v34 filters:', JSON.stringify(filters));
    console.log('v34 inline filters:', JSON.stringify(inlineFilters));
    console.log('v34 processed inline filters:', JSON.stringify(processedInlineFilters));
    console.log('v34 sort fields:', JSON.stringify(sortFields));
    console.log('v34 index type:', indexType);

    // Determine which index to use - for index types 0, 3, 5 use the color summary index
    let indexName;
    const currentDate = new Date();
    const yearString = currentDate.getFullYear().toString();

    if (['0', '3', '5'].includes(indexType)) {
      // Use the accessory summary index for these types
      indexName = [`pipe-rgn-dlr-dist-sale-accessory-current-summary-${yearString}`];
    } else if (indexType === '6') {
      const previousYearString = (currentDate.getFullYear() - 1).toString();
      indexName = [`pipe-rgn-dlr-dist-sale-accessory-current-summary-${previousYearString}`];
    } else {
      if (filters && filters.sls_ccyymm && filters.sls_ccyymm.length > 0) {
        // Extract years from CCYYMM format (first 4 digits)
        const years = filters.sls_ccyymm.map(val => {
          const ccyymm = val.toString().padStart(6, '0');
          return parseInt(ccyymm.substring(0, 4));
        });

        const minYear = Math.min(...years);
        const maxYear = Math.max(...years);

        console.log(`v34 Min year: ${minYear}, Max year: ${maxYear}`);
        if (minYear === maxYear) {
          indexName = [`pipe-rgn-dlr-dist-sale-accessory-current-summary-${minYear}`];
        } else {
          indexName = [`pipe-rgn-dlr-dist-sale-accessory-current-summary-${minYear}`, `pipe-rgn-dlr-dist-sale-accessory-current-summary-${maxYear}`];
        }
      } else {
        // Default to current year index
        indexName = [`pipe-rgn-dlr-dist-sale-accessory-current-summary-${yearString}`];
      }
    }

    console.log('v34 index name:', indexName);

    // Execute enhanced query using the new v34 service method with OpenSearch-based filtering and sorting
    const initialResult = await pipService.ModifiedexecutePaginatedQueryV34(
      filters,
      { page: 1, page_size: 50000 }, // Large page size for comprehensive results
      indexName,
      indexType,
      processedInlineFilters, // Pass processed inline filters to OpenSearch
      sortFields     // Pass sort fields to OpenSearch
    );

    if (!initialResult.success) {
      return next(new Error(initialResult.error));
    }

    // Get aggregated data (already filtered and sorted by OpenSearch)
    let aggregatedData = initialResult.data || [];
    console.log(`V34 Data count after OpenSearch processing: ${aggregatedData.length}`);

    // Transform data into enhanced hierarchical structure first
    const transformedData = pipService._transformToHierarchicalStructureV34(aggregatedData, pagination);

    // Apply pagination at the region level
    const totalRegions = transformedData.regionSummary.regions.length;
    const startIndex = (pagination.page - 1) * pagination.page_size;
    const endIndex = startIndex + pagination.page_size;

    // Get paginated regions
    const paginatedRegions = transformedData.regionSummary.regions.slice(startIndex, endIndex);

    // Recalculate totals for paginated regions only
    const numericFields = [
      'sales_availability_count', 'days_supply_count', 'retail_count', 'vpc_stock_count',
      'unbuilt_count', 'company_stock_count', 'dealer_stock_count', 'intransit_othervpc_count',
      'totalstock_count', 'other_vpc_count', 'postprocess_intransit_count', 'preprocess_intransit_vpc_count',
      'wholesale_count', 'hist_dealerstock_count', 'hist_tmsstock_count', 'hist_mfgstock_count',
      'hist_portstock_count', 'hist_intransitstock_count', 'distributor_count', 'retail_objective_count',
      'wholesale_objective_count', 'dealer_retail_obj', 'series_retail_ytd_obj', 'series_wholesale_ytd_obj',
      'region_retail_ytd_obj', 'region_wholesale_ytd_obj'
    ];

    const paginatedTotals = {};
    numericFields.forEach(field => {
      paginatedTotals[field] = 0;
    });

    paginatedRegions.forEach(region => {
      numericFields.forEach(field => {
        paginatedTotals[field] += (region[field] || 0);
      });
    });

    // Calculate paginated totals percentages
    const paginatedRetailCount = paginatedTotals.retail_count || 0;
    const paginatedRetailObjective = paginatedTotals.retail_objective_count || 0;
    const paginatedWholesaleCount = paginatedTotals.wholesale_count || 0;
    const paginatedWholesaleObjective = paginatedTotals.wholesale_objective_count || 0;
    const paginatedDealerStockCount = paginatedTotals.dealer_stock_count || 0;

    paginatedTotals.retail_objective_percentage = paginatedRetailObjective > 0
      ? parseFloat(((paginatedRetailCount / paginatedRetailObjective) * 100).toFixed(2))
      : 0;
    paginatedTotals.wholesale_objective_percentage = paginatedWholesaleObjective > 0
      ? parseFloat(((paginatedWholesaleCount / paginatedWholesaleObjective) * 100).toFixed(2))
      : 0;

    // Always set sales_to_availability to 0 as per requirement
    paginatedTotals.sales_to_availability = 0;

    // Filter response to include only required fields
    const filterResponseFields = (obj, level) => {
      // Base fields that are common to all levels
      const commonFields = ['sales_availability_count', 'days_supply_count', 'retail_count', 'wholesale_count',
        'distributor_count', 'vpc_stock_count', 'unbuilt_count', 'company_stock_count',
        'dealer_stock_count', 'intransit_othervpc_count', 'totalstock_count', 'other_vpc_count',
        'postprocess_intransit_count', 'preprocess_intransit_vpc_count', 'hist_dealerstock_count',
        'hist_tmsstock_count', 'hist_mfgstock_count', 'hist_portstock_count',
        'hist_intransitstock_count', 'sales_to_availability'];

      // Objective fields that should only exist at region level
      const regionOnlyFields = ['retail_objective_count', 'retail_objective_percentage',
        'wholesale_objective_count', 'wholesale_objective_percentage'];

      const filtered = {};

      if (level === 'region') {
        filtered.region_code = obj.region_code;
        filtered.region_name = obj.region_name;
        filtered.brand_code = obj.brand_code;
        filtered.objective_available_indicator = obj.objective_available_indicator;
        // Note: region_display_order is excluded from response as it's only used for sorting

        // Add all fields including objective fields for regions
        [...commonFields, ...regionOnlyFields].forEach(field => {
          filtered[field] = obj[field] || 0;
        });
      } else if (level === 'district') {
        filtered.district_code = obj.district_code;
        filtered.district_name = obj.district_name;
        filtered.brand_code = obj.brand_code;
        filtered.vehicle_assignment_indicator = obj.vehicle_assignment_indicator;

        // Add only common fields (exclude objective fields for districts)
        commonFields.forEach(field => {
          filtered[field] = obj[field] || 0;
        });
      } else if (level === 'dealer') {
        filtered.dealer_code = obj.dealer_code;
        filtered.dealer_name = obj.dealer_name;
        filtered.brand_code = obj.brand_code;
        filtered.vehicle_assignment_indicator = obj.vehicle_assignment_indicator;

        // Add only common fields (exclude objective fields for dealers)
        commonFields.forEach(field => {
          filtered[field] = obj[field] || 0;
        });
      }

      return filtered;
    };

    // Filter paginated regions
    const filteredRegions = paginatedRegions.map(region => {
      const filteredRegion = filterResponseFields(region, 'region');
      filteredRegion.districts = region.districts.map(district => {
        const filteredDistrict = filterResponseFields(district, 'district');
        filteredDistrict.dealers = district.dealers.map(dealer =>
          filterResponseFields(dealer, 'dealer')
        );
        return filteredDistrict;
      });
      return filteredRegion;
    });

    // Filter totals to include only required fields
    const filteredTotals = {};
    const totalFields = ['sales_availability_count', 'days_supply_count', 'retail_count', 'wholesale_count',
      'distributor_count', 'retail_objective_count', 'retail_objective_percentage',
      'wholesale_objective_count', 'wholesale_objective_percentage', 'vpc_stock_count',
      'unbuilt_count', 'company_stock_count', 'dealer_stock_count', 'intransit_othervpc_count',
      'totalstock_count', 'other_vpc_count', 'postprocess_intransit_count',
      'preprocess_intransit_vpc_count', 'hist_dealerstock_count', 'hist_tmsstock_count',
      'hist_mfgstock_count', 'hist_portstock_count', 'hist_intransitstock_count', 'sales_to_availability'];

    totalFields.forEach(field => {
      filteredTotals[field] = paginatedTotals[field] || 0;
    });

    // Create pagination info without total_regions
    const totalPages = Math.ceil(totalRegions / pagination.page_size);
    const updatedPaginationInfo = {
      current_page: pagination.page,
      page_size: filteredRegions.length,
      total_pages: totalPages,
      has_next_page: endIndex < totalRegions,
      has_previous_page: startIndex > 0
    };

    // Calculate count as the total number of regions before pagination
    const correctCount = totalRegions;

    // Prepare enhanced response with filtered regions
    const result = {
      data: {
        regionSummary: {
          count: correctCount,
          regions: filteredRegions,
          totals: filteredTotals
        }
      },
      pagination: updatedPaginationInfo
    };

    // Convert boolean fields in the filtered regions
    result.data.regionSummary.regions.forEach(region => {
      if (region.objective_available_indicator !== undefined) {
        region.objective_available_indicator = convertToBoolean(region.objective_available_indicator);
      }

      region.districts.forEach(district => {
        if (district.vehicle_assignment_indicator !== undefined) {
          district.vehicle_assignment_indicator = convertToBoolean(district.vehicle_assignment_indicator);
        }

        district.dealers.forEach(dealer => {
          if (dealer.vehicle_assignment_indicator !== undefined) {
            dealer.vehicle_assignment_indicator = convertToBoolean(dealer.vehicle_assignment_indicator);
          }
        });
      });
    });

    console.log(`V34 pagination: Total regions: ${totalRegions}, Page: ${pagination.page}, Regions in page: ${paginatedRegions.length}`);
    return res.json(result);
  } catch (error) {
    console.error('Error in POST /summary/byRegion-Accessory:', error);
    next(error);
  }
});
// POST /summary/bySeries-Color - New endpoint with series/model code structure and enhanced query logic
router.post('/summary/modified/bySeries-Color', validateRequest({ body: postSeriesColorSummaryNewSchema }), async (req, res, next) => {
  try {
    console.log('entered the series_color_summary_new function');
    const indexPar = req.query.index_par;
    logIndexPar('post_series_color_summary_new', indexPar);

    // Get request parameters
    const filters = req.body.filters || null;
    const inlineFilters = req.body.inlinefilter || [];
    const sortFields = req.body.sortfields || [];
    const pagination = req.body.pagination || { page: 1, page_size: 10 };
    const indexType = req.body.index_type || '0';

    console.log('series_color_summary_new filters:', JSON.stringify(filters));
    console.log('series_color_summary_new inline filters:', JSON.stringify(inlineFilters));
    console.log('series_color_summary_new sort fields:', JSON.stringify(sortFields));
    console.log('series_color_summary_new index type:', indexType);

    // Convert filter values to uppercase for specified fields (excluding boolean fields)
    const processedFilters = filters ? { ...filters } : null;
    if (processedFilters) {
      const fieldsToCapitalize = [
        'distributor_code', 'region_code', 'region_name', 'dealer_code', 'dealer_name',
        'dealer_group_name', 'dealer_type', 'district_code', 'district_name',
        'vehicle_assignment_indicator', 'model_year', 'model_code', 'fd_fleet_description',
        'brand_code', 'segment_code', 'subsegment_code', 'team_member_lease_sale_type',
        'nap_cbu_code', 'series_name', 'series_display_order', 'grade_code',
        'transmissiontype_code', 'drivetrain_code', 'fueltype_code', 'enginefueltype_code',
        'exterior_color_code', 'exterior_color_desc', 'interior_color_code', 'interior_trim_color_desc'
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

    // Determine which index to use - for index types 0, 3, 5 use the color summary index
    let indexName;
    const currentDate = new Date();
    const yearString = currentDate.getFullYear().toString();

    if (['0', '3', '5'].includes(indexType)) {
      // Use the color summary index for these types
      indexName = [`pipe-rgn-dlr-dist-sale-color-current-summary-${yearString}`];
    } else if (indexType === '6') {
      const previousYearString = (currentDate.getFullYear() - 1).toString();
      indexName = [`pipe-rgn-dlr-dist-color-current-summary-${previousYearString}`];
    } else {
      if (processedFilters && processedFilters.sls_ccyymm && processedFilters.sls_ccyymm.length > 0) {
        // Extract years from CCYYMM format (first 4 digits)
        const years = processedFilters.sls_ccyymm.map(val => {
          const ccyymm = val.toString().padStart(6, '0');
          return parseInt(ccyymm.substring(0, 4));
        });

        const minYear = Math.min(...years);
        const maxYear = Math.max(...years);

        console.log(`series_color_summary_new Min year: ${minYear}, Max year: ${maxYear}`);
        if (minYear === maxYear) {
          indexName = [`pipe-rgn-dlr-dist-color-current-summary-${minYear}`];
        } else {
          indexName = [`pipe-rgn-dlr-dist-color-current-summary-${minYear}`, `pipe-rgn-dlr-dist-color-current-summary-${maxYear}`];
        }
      } else {
        // Default to current year index
        indexName = [`pipe-rgn-dlr-dist-color-current-summary-${yearString}`];
      }
    }

    console.log('series_color_summary_new index name:', indexName);

    // Execute query using the new series color summary service method
    const initialResult = await pipService.ModifiedexecuteSeriesColorSummaryQuery(
      processedFilters,
      { page: 1, page_size: 50000 }, // Large page size for comprehensive results
      indexName,
      indexType,
      inlineFilters,
      sortFields
    );

    if (!initialResult.success) {
      return next(new Error(initialResult.error));
    }

    // Get aggregated data (already filtered and sorted by OpenSearch)
    let aggregatedData = initialResult.data || [];
    console.log(`series_color_summary_new Data count after OpenSearch processing: ${aggregatedData.length}`);

    // Debug: Log sample data to see what we're getting from the service
    if (aggregatedData.length > 0) {
      console.log('series_color_summary_new Sample data from service:', JSON.stringify(aggregatedData[0], null, 2));
    }

    // Transform data into series hierarchical structure
    const transformedData = transformToSeriesColorSummaryStructure(aggregatedData, indexType);

    // Filter out DUMMY series and model codes with 0000 from final response
    // Keep original totals (calculated from all data including DUMMY/0000)
    const originalTotals = { ...transformedData.seriesSummary.totals };

    const filteredSeries = transformedData.seriesSummary.series
      .filter(series => series.series_name !== 'DUMMY')
      .map(series => ({
        ...series,
        modelCodes: series.modelCodes.filter(model => model.model_code !== '0000')
      }));

    // Apply pagination at the series level (after filtering)
    const totalSeries = filteredSeries.length;
    const startIndex = (pagination.page - 1) * pagination.page_size;
    const endIndex = startIndex + pagination.page_size;

    // Get paginated series
    const paginatedSeries = filteredSeries.slice(startIndex, endIndex);

    // Recalculate totals for paginated series only
    const numericFields = [
      'sales_availability_count', 'days_supply_count', 'retail_count', 'wholesale_count',
      'distributor_count', 'vpc_stock_count', 'unbuilt_count', 'company_stock_count',
      'dealer_stock_count', 'intransit_othervpc_count', 'totalstock_count', 'other_vpc_count',
      'postprocess_intransit_count', 'preprocess_intransit_vpc_count', 'hist_dealerstock_count',
      'hist_tmsstock_count', 'hist_mfgstock_count', 'hist_portstock_count',
      'hist_intransitstock_count', 'sales_to_availability', 'retail_objective_count',
      'wholesale_objective_count'
    ];

    const paginatedTotals = {};
    numericFields.forEach(field => {
      paginatedTotals[field] = 0;
    });

    paginatedSeries.forEach(series => {
      numericFields.forEach(field => {
        paginatedTotals[field] += (series[field] || 0);
      });
    });

    // Calculate paginated totals percentages
    const paginatedRetailCount = paginatedTotals.retail_count || 0;
    const paginatedRetailObjective = paginatedTotals.retail_objective_count || 0;
    const paginatedWholesaleCount = paginatedTotals.wholesale_count || 0;
    const paginatedWholesaleObjective = paginatedTotals.wholesale_objective_count || 0;

    paginatedTotals.retail_objective_percentage = paginatedRetailObjective > 0
      ? parseFloat(((paginatedRetailCount / paginatedRetailObjective) * 100).toFixed(1))
      : 0;
    paginatedTotals.wholesale_objective_percentage = paginatedWholesaleObjective > 0
      ? parseFloat(((paginatedWholesaleCount / paginatedWholesaleObjective) * 100).toFixed(1))
      : 0;

    // Create pagination info
    const totalPages = Math.ceil(totalSeries / pagination.page_size);
    const updatedPaginationInfo = {
      current_page: pagination.page,
      page_size: paginatedSeries.length,
      total_pages: totalPages,
      has_next_page: endIndex < totalSeries,
      has_previous_page: startIndex > 0
    };

    // Prepare response with paginated series
    // Use original totals (includes DUMMY/0000 for calculations) but filtered series for display
    const result = {
      seriesSummary: {
        count: totalSeries,
        series: paginatedSeries,
        totals: originalTotals // Keep totals calculated from all data including DUMMY/0000
      },
      pagination: updatedPaginationInfo
    };

    console.log(`series_color_summary_new pagination: Total series: ${totalSeries}, Page: ${pagination.page}, Series in page: ${paginatedSeries.length}`);
    return res.json(result);
  } catch (error) {
    console.error('Error in POST /summary/bySeries-Color:', error);
    next(error);
  }
});

// POST /summary/bySeries-Accessory - New endpoint with series/model code structure and accessory query logic
router.post('/summary/modified/bySeries-Accessory', validateRequest({ body: postSeriesAccSummaryNewSchema }), async (req, res, next) => {
  try {
    console.log('entered the series_acc_summary_new function');
    const indexPar = req.query.index_par;
    logIndexPar('post_series_acc_summary_new', indexPar);

    // Get request parameters
    const filters = req.body.filters || null;
    const inlineFilters = req.body.inlinefilter || [];
    const sortFields = req.body.sortfields || [];
    const pagination = req.body.pagination || { page: 1, page_size: 10 };
    const indexType = req.body.index_type || '0';

    console.log('series_acc_summary_new filters:', JSON.stringify(filters));
    console.log('series_acc_summary_new inline filters:', JSON.stringify(inlineFilters));
    console.log('series_acc_summary_new sort fields:', JSON.stringify(sortFields));
    console.log('series_acc_summary_new index type:', indexType);

    // Convert filter values to uppercase for specified fields (excluding boolean fields)
    const processedFilters = filters ? { ...filters } : null;
    if (processedFilters) {
      const fieldsToCapitalize = [
        'distributor_code', 'region_code', 'region_name', 'dealer_code', 'dealer_name',
        'dealer_group_name', 'dealer_type', 'district_code', 'district_name',
        'vehicle_assignment_indicator', 'model_year', 'model_code', 'fd_fleet_description',
        'brand_code', 'segment_code', 'subsegment_code', 'team_member_lease_sale_type',
        'nap_cbu_code', 'series_name', 'series_display_order', 'grade_code',
        'transmissiontype_code', 'drivetrain_code', 'fueltype_code', 'enginefueltype_code',
        // Accessory fields (replacing color fields)
        'fio_ppo_indicator', 'accessory_code', 'accessory_desc'
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

    // Determine which index to use - for index types 0, 3, 5 use the color summary index
    let indexName;
    const currentDate = new Date();
    const yearString = currentDate.getFullYear().toString();

    if (['0', '3', '5'].includes(indexType)) {
      // Use the accessory summary index for these types
      indexName = [`pipe-rgn-dlr-dist-sale-accessory-current-summary-${yearString}`];
    } else if (indexType === '6') {
      const previousYearString = (currentDate.getFullYear() - 1).toString();
      indexName = [`pipe-rgn-dlr-dist-sale-accessory-current-summary-${previousYearString}`];
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
          indexName = [`pipe-rgn-dlr-dist-sale-accessory-current-summary-${minYear}`];
        } else {
          indexName = [`pipe-rgn-dlr-dist-sale-accessory-current-summary-${minYear}`, `pipe-rgn-dlr-dist-sale-accessory-current-summary-${maxYear}`];
        }
      } else {
        // Default to current year index
        indexName = [`pipe-rgn-dlr-dist-sale-accessory-current-summary-${yearString}`];
      }
    }

    console.log('series_acc_summary_new index name:', indexName);

    // Execute query using the new series accessory summary service method
    const initialResult = await pipService.ModifiedexecuteSeriesAccSummaryQuery(
      processedFilters,
      { page: 1, page_size: 50000 }, // Large page size for comprehensive results
      indexName,
      indexType,
      inlineFilters,
      sortFields
    );

    if (!initialResult.success) {
      return next(new Error(initialResult.error));
    }

    // Get aggregated data (already filtered and sorted by OpenSearch)
    let aggregatedData = initialResult.data || [];
    console.log(`series_acc_summary_new Data count after OpenSearch processing: ${aggregatedData.length}`);

    // Debug: Log sample data to see what we're getting from the service
    if (aggregatedData.length > 0) {
      console.log('series_acc_summary_new Sample data from service:', JSON.stringify(aggregatedData[0], null, 2));
    }

    // Transform data into series hierarchical structure
    const transformedData = transformToSeriesAccSummaryStructure(aggregatedData, indexType);

    // Filter out DUMMY series and model codes with 0000 from final response
    // Keep original totals (calculated from all data including DUMMY/0000)
    const originalTotals = { ...transformedData.seriesSummary.totals };

    const filteredSeries = transformedData.seriesSummary.series
      .filter(series => series.series_name !== 'DUMMY')
      .map(series => ({
        ...series,
        modelCodes: series.modelCodes.filter(model => model.model_code !== '0000')
      }));

    // Apply pagination at the series level (after filtering)
    const totalSeries = filteredSeries.length;
    const startIndex = (pagination.page - 1) * pagination.page_size;
    const endIndex = startIndex + pagination.page_size;

    // Get paginated series
    const paginatedSeries = filteredSeries.slice(startIndex, endIndex);

    // Recalculate totals for paginated series only
    const numericFields = [
      'sales_availability_count', 'days_supply_count', 'retail_count', 'wholesale_count',
      'distributor_count', 'vpc_stock_count', 'unbuilt_count', 'company_stock_count',
      'dealer_stock_count', 'intransit_othervpc_count', 'totalstock_count', 'other_vpc_count',
      'postprocess_intransit_count', 'preprocess_intransit_vpc_count', 'hist_dealerstock_count',
      'hist_tmsstock_count', 'hist_mfgstock_count', 'hist_portstock_count',
      'hist_intransitstock_count', 'sales_to_availability', 'retail_objective_count',
      'wholesale_objective_count'
    ];

    const paginatedTotals = {};
    numericFields.forEach(field => {
      paginatedTotals[field] = 0;
    });

    paginatedSeries.forEach(series => {
      numericFields.forEach(field => {
        paginatedTotals[field] += (series[field] || 0);
      });
    });

    // Calculate paginated totals percentages
    const paginatedRetailCount = paginatedTotals.retail_count || 0;
    const paginatedRetailObjective = paginatedTotals.retail_objective_count || 0;
    const paginatedWholesaleCount = paginatedTotals.wholesale_count || 0;
    const paginatedWholesaleObjective = paginatedTotals.wholesale_objective_count || 0;

    paginatedTotals.retail_objective_percentage = paginatedRetailObjective > 0
      ? parseFloat(((paginatedRetailCount / paginatedRetailObjective) * 100).toFixed(1))
      : 0;
    paginatedTotals.wholesale_objective_percentage = paginatedWholesaleObjective > 0
      ? parseFloat(((paginatedWholesaleCount / paginatedWholesaleObjective) * 100).toFixed(1))
      : 0;

    // Create pagination info
    const totalPages = Math.ceil(totalSeries / pagination.page_size);
    const updatedPaginationInfo = {
      current_page: pagination.page,
      page_size: paginatedSeries.length,
      total_pages: totalPages,
      has_next_page: endIndex < totalSeries,
      has_previous_page: startIndex > 0
    };

    // Prepare response with paginated series
    // Use original totals (includes DUMMY/0000 for calculations) but filtered series for display
    const result = {
      seriesSummary: {
        count: totalSeries,
        series: paginatedSeries,
        totals: originalTotals // Keep totals calculated from all data including DUMMY/0000
      },
      pagination: updatedPaginationInfo
    };

    console.log(`series_acc_summary_new pagination: Total series: ${totalSeries}, Page: ${pagination.page}, Series in page: ${paginatedSeries.length}`);
    return res.json(result);
  } catch (error) {
    console.error('Error in POST /summary/bySeries-Accessory:', error);
    next(error);
  }
});
module.exports = router;