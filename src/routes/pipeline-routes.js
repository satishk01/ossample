const express = require('express');
const router = express.Router();
const Joi = require('joi');
const { validateRequest } = require('../middleware/validation');
const PipelineQueryService = require('../services/pipeline-query-service');
const { FilterCondition, PaginationRequest } = require('../models/request-models');
const settings = require('../config/settings');
//Accesory
const ACCESSORY_CURRENT_INDEX = 'pipe-rgn-dlr-dist-sale-accessory-current-summary';
const ACCESSORY_10DAY_INDEX = 'pipe-rgn-dlr-dist-sale-inv-accessory-10day-summary';
const ACCESSORY_20DAY_INDEX = 'pipe-rgn-dlr-dist-sale-inv-accessory-20day-summary';
const ACCESSORY_MONTH_INDEX = 'pipe-rgn-dlr-dist-sale-inv-accessory-month-summary';
//Color
const COLOR_CURRENT_INDEX = 'pipe-rgn-dlr-dist-sale-color-current-summary';
const COLOR_10DAY_INDEX = 'pipe-rgn-dlr-dist-sale-inv-color-10day-summary';
const COLOR_20DAY_INDEX = 'pipe-rgn-dlr-dist-sale-inv-color-20day-summary';
const COLOR_MONTH_INDEX = 'pipe-rgn-dlr-dist-sale-color-month-summary';

const RETAIL_VEHICLE_INDEX = 'pipe-vh-vehicle-info';

// Logger function for index_par
const logIndexPar = (endpointName, indexPar) => {
  if (indexPar) {
    console.log(`[INFO] [${endpointName}] index_par: ${indexPar}`);
  }
};

// Initialize PIPQueryService once
const pipService = new PipelineQueryService();
// POST /retailvehicle schema - Retail Vehicle Lookup API
const postRetailVehicleSchema = Joi.object({
  filters: Joi.object({
    region_code: Joi.array().items(Joi.string()).optional(),
    district_code: Joi.array().items(Joi.string()).optional(),
    dealer_code: Joi.array().items(Joi.string()).optional(),
    distributor_code: Joi.array().items(Joi.string()).optional(),
    model_year: Joi.array().items(Joi.string()).optional(),
    model_code: Joi.array().items(Joi.string()).optional(),
    fleet_flag: Joi.array().items(Joi.boolean()).optional(),
    brand_name: Joi.array().items(Joi.string()).optional(),
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

//Retail Vehicle Lookup API
router.post('/retailvehicle', validateRequest({ body: postRetailVehicleSchema }), async (req, res, next) => {
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
          count: totalVehicles,//cleanedVehicles.length,
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
    console.error('Error in POST /retailvehicle:', error);
    next(error);
  }
});

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
//KPI TILES
router.post('/kpitiles', validateRequest({ body: postChartSchema }), async (req, res, next) => {
  try {
    const { filters, indexName } = pipService.getRequestData(req, ACCESSORY_CURRENT_INDEX, COLOR_CURRENT_INDEX);
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
    const query = pipService.buildKpiTilesAggQuery(modifiedFilter || {}, req.body.index_type);
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
//KPI TILES
router.post('/modified/kpitiles', validateRequest({ body: postChartSchema }), async (req, res, next) => {
  try {
    const { filters, indexName } = pipService.modifiedGetRequestData(req, ACCESSORY_CURRENT_INDEX, COLOR_CURRENT_INDEX, ACCESSORY_10DAY_INDEX, COLOR_10DAY_INDEX, ACCESSORY_20DAY_INDEX, COLOR_20DAY_INDEX);
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
    const query = pipService.modifiedBuildKpiTilesAggQuery(modifiedFilter || {}, req.body.index_type);
    console.log(`route query ${JSON.stringify(query)}`);
    const client = await pipService.getClient();
    const response = await client.search({
      index: indexName || settings.indexNamesList,
      body: query,
      timeout: '30s'
    });
    const aggs = response.aggregations || response.body?.aggregations;
    console.log(`response ${JSON.stringify(aggs)}`);
    const kpiTiles = pipService.modifiedBuildKpiTilesResponse(aggs);
    return res.json(kpiTiles);
  } catch (error) {
    return next(error);
  }
});
//SALESBYSEGMENTCHART
router.post('/bySegmentType', validateRequest({ body: postChartSchema }), async (req, res, next) => {
  try {
    console.log('entered the salesBySegmentChart function');
    const indexPar = req.query.index_par;
    logIndexPar('post_sales_by_segment_chart', indexPar);
    console.log('Request body:', req.body);

    const { filters, indexName } = pipService.getRequestData(req, ACCESSORY_CURRENT_INDEX, COLOR_CURRENT_INDEX);

    console.log('Final index name:', indexName);

    const initialResult = await pipService.executeSalesChartQuery(
      filters || null,
      indexName,
      "segment_code",
      req.body.index_type
    );
    console.log('Final filters object:', JSON.stringify(filters));

    if (!initialResult.success) {
      return next(new Error(initialResult.error));
    }

    return res.json(initialResult.data);


  } catch (error) {
    console.error('Error in POST /bySegmentType:', error);
    next(error);
  }
});
//ENGINECHART
router.post('/byEngineType', validateRequest({ body: postChartSchema }), async (req, res, next) => {
  try {
    console.log('entered the salesByEngineChart function');
    const indexPar = req.query.index_par;
    logIndexPar('post_sales_by_engine_chart', indexPar);
    console.log('Request body:', req.body);

    const { filters, indexName } = pipService.getRequestData(req, ACCESSORY_CURRENT_INDEX, COLOR_CURRENT_INDEX);

    console.log('Final index name:', indexName);

    const initialResult = await pipService.executeSalesChartQuery(
      filters || null,
      indexName,
      "enginefueltype_code",
       req.body.index_type
    );
    console.log('Final filters object:', JSON.stringify(filters));

    if (!initialResult.success) {
      return next(new Error(initialResult.error));
    }

    return res.json(initialResult.data);


  } catch (error) {
    console.error('Error in POST /bySegmentType:', error);
    next(error);
  }
});
router.post('/bySeries', validateRequest({ body: postChartSchema }), async (req, res, next) => {
  try {
    console.log('entered the salesBySeriesChart function');
    const indexPar = req.query.index_par;
    logIndexPar('post_sales_by_series_chart', indexPar);
    console.log('Request body:', req.body);

    const { filters, indexName } = pipService.getRequestData(req, ACCESSORY_CURRENT_INDEX, COLOR_CURRENT_INDEX);

    console.log('Final index name:', indexName);

    const initialResult = await pipService.executeSalesChartQuery(
      filters || null,
      indexName,
      "series_name",
      req.body.index_type
    );
    console.log('Final filters object:', JSON.stringify(filters));

    if (!initialResult.success) {
      return next(new Error(initialResult.error));
    }

    return res.json(initialResult.data);


  } catch (error) {
    console.error('Error in POST /bySegmentType:', error);
    next(error);
  }
});
module.exports = router;