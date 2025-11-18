const express = require('express');
const router = express.Router();
const Joi = require('joi');
const { validateRequest } = require('../middleware/validation');
const AuditQueryService = require('../services/audit-query-service');

// Initialize AuditQueryService
const auditService = new AuditQueryService();

// POST /audit/Audit-history schema
const postAuditHistorySchema = Joi.object({
    filters: Joi.object({
        audit_vehicle_id: Joi.array().items(Joi.string()).optional(),
        vin: Joi.array().items(Joi.string()).optional(),
        urn: Joi.array().items(Joi.string()).optional(),
        model_year: Joi.array().items(Joi.string()).optional(),
        model_code: Joi.array().items(Joi.string()).optional(),
        distributor_name: Joi.array().items(Joi.string()).optional(),
        region_name: Joi.array().items(Joi.string()).optional(),
        region_id: Joi.array().items(Joi.string()).optional(),
        dealer_code: Joi.array().items(Joi.string()).optional(),
        fleet_indicator: Joi.array().items(Joi.boolean()).optional(),
        sales_series: Joi.array().items(Joi.string()).optional(),
        sales_business_date: Joi.object({
            gte: Joi.string().optional().description('Start date (yyyy-MM-dd)'),
            lte: Joi.string().optional().description('End date (yyyy-MM-dd)')
        }).optional(),
        sales_business_year_month_key: Joi.array().items(Joi.string()).optional(),
        sales_process_id: Joi.array().items(Joi.number()).optional(),
        sales_process_name: Joi.array().items(Joi.string()).optional(),
        sales_event_status_id: Joi.array().items(Joi.number()).optional(),
        sales_event_status: Joi.array().items(Joi.string()).optional(),
        status_message: Joi.array().items(Joi.string()).optional(),
        event_message_id: Joi.array().items(Joi.string()).optional(),
        batch_id: Joi.array().items(Joi.string()).optional(),
        audit_vehicle_sequence: Joi.array().items(Joi.number()).optional(),
        create_id: Joi.array().items(Joi.string()).optional(),
        create_ts: Joi.object({
            gte: Joi.string().optional().description('Start date (yyyy-MM-dd)'),
            lte: Joi.string().optional().description('End date (yyyy-MM-dd)')
        }).optional(),
        update_id: Joi.array().items(Joi.string()).optional(),
        update_ts: Joi.object({
            gte: Joi.string().optional().description('Start date (yyyy-MM-dd)'),
            lte: Joi.string().optional().description('End date (yyyy-MM-dd)')
        }).optional()
    }).optional().description('Global filters object'),
    inlinefilter: Joi.array().items(
        Joi.object({
            field: Joi.string().valid(
                'audit_vehicle_id', 'vin', 'urn', 'model_year', 'model_code',
                'distributor_name', 'region_name', 'region_id', 'dealer_code',
                'fleet_indicator', 'sales_series', 'sales_business_date',
                'sales_business_year_month_key', 'sales_process_id', 'sales_process_name',
                'sales_event_status_id', 'sales_event_status', 'status_message',
                'event_message_id', 'batch_id', 'audit_vehicle_sequence',
                'create_id', 'create_ts', 'update_id', 'update_ts'
            ).required(),
            condition: Joi.string().valid('>=', '<=', '=', '>', '<', '!=', 'contains', 'not_contains').required(),
            value: Joi.alternatives().try(Joi.number(), Joi.string(), Joi.boolean()).required()
        })
    ).optional().description('Inline filters to apply to audit data'),
    pagination: Joi.object({
        page: Joi.number().integer().min(1).default(1),
        page_size: Joi.number().integer().min(1).max(1000).default(25)
    }).default({ page: 1, page_size: 25 }),
    sortfields: Joi.array().items(
        Joi.object({
            field: Joi.string().valid(
                'audit_vehicle_id', 'vin', 'urn', 'model_year', 'model_code',
                'distributor_name', 'region_name', 'region_id', 'dealer_code',
                'fleet_indicator', 'sales_series', 'sales_business_date',
                'sales_business_year_month_key', 'sales_process_id', 'sales_process_name',
                'sales_event_status_id', 'sales_event_status', 'status_message',
                'event_message_id', 'batch_id', 'audit_vehicle_sequence',
                'create_id', 'create_ts', 'update_id', 'update_ts'
            ).required(),
            order: Joi.string().valid('asc', 'desc').required()
        })
    ).optional().description('Fields to sort audit data by')
});

// GET /audit/debug - Debug endpoint to check index contents
router.get('/audit/debug', async (req, res, next) => {
  try {
    console.log('Debug endpoint called');
    
    const auditService = new AuditQueryService();
    const client = await auditService.getClient();
    
    // Check audit vehicles index
    const vehiclesQuery = {
      size: 5,
      query: { match_all: {} }
    };
    
    const vehiclesResponse = await client.search({
      index: 'audit_vehicles_2026',
      body: vehiclesQuery,
      timeout: '10s'
    });
    
    const vehicleHits = vehiclesResponse.body?.hits?.hits || [];
    const vehiclesTotalCount = vehiclesResponse.body?.hits?.total?.value || 0;
    
    // Check audit details index
    const detailsQuery = {
      size: 5,
      query: { match_all: {} }
    };
    
    const detailsResponse = await client.search({
      index: 'audit_details_2026',
      body: detailsQuery,
      timeout: '10s'
    });
    
    const detailHits = detailsResponse.body?.hits?.hits || [];
    const detailsTotalCount = detailsResponse.body?.hits?.total?.value || 0;
    
    // Extract sample audit vehicle IDs from vehicles index
    const sampleVehicleIds = vehicleHits.map(hit => hit._source?.audit_vehicle_id).filter(id => id);
    
    // Check if any of these IDs exist in details index
    let matchingDetails = [];
    if (sampleVehicleIds.length > 0) {
      const matchQuery = {
        size: 10,
        query: {
          terms: {
            "audit_vehicle_id": sampleVehicleIds
          }
        }
      };
      
      try {
        const matchResponse = await client.search({
          index: 'audit_details_2026',
          body: matchQuery,
          timeout: '10s'
        });
        matchingDetails = matchResponse.body?.hits?.hits || [];
      } catch (matchError) {
        console.log('Match query failed:', matchError.message);
      }
    }
    
    const debugInfo = {
      audit_vehicles_2026: {
        total_count: vehiclesTotalCount,
        sample_records: vehicleHits.length,
        sample_vehicle_ids: sampleVehicleIds,
        sample_data: vehicleHits.map(hit => ({
          audit_vehicle_id: hit._source?.audit_vehicle_id,
          vin: hit._source?.vin,
          urn: hit._source?.urn,
          create_ts: hit._source?.create_ts
        }))
      },
      audit_details_2026: {
        total_count: detailsTotalCount,
        sample_records: detailHits.length,
        sample_data: detailHits.map(hit => ({
          audit_vehicle_id: hit._source?.audit_vehicle_id,
          audit_detail_id: hit._source?.audit_detail_id,
          sales_event_flow_name: hit._source?.sales_event_flow_name,
          create_detail_ts: hit._source?.create_detail_ts
        }))
      },
      matching_details: {
        found_matches: matchingDetails.length,
        matches: matchingDetails.map(hit => ({
          audit_vehicle_id: hit._source?.audit_vehicle_id,
          sales_event_flow_name: hit._source?.sales_event_flow_name
        }))
      }
    };
    
    return res.json({
      status: 'SUCCESS',
      debug_info: debugInfo,
      message: 'Debug information retrieved successfully'
    });
    
  } catch (error) {
    console.error('Error in debug endpoint:', error);
    return res.status(500).json({
      status: 'ERROR',
      message: error.message,
      error: error.stack
    });
  }
});

// POST /audit/Audit-history - Audit History Lookup API
router.post('/audit/Audit-history', validateRequest({ body: postAuditHistorySchema }), async (req, res, next) => {
    try {
        console.log('Entered audit history lookup function');

        const filters = req.body.filters || null;
        const inlineFilters = req.body.inlinefilter || [];
        const sortFields = req.body.sortfields || [];
        const pagination = req.body.pagination || { page: 1, page_size: 25 };

        console.log('Audit filters:', JSON.stringify(filters));
        console.log('Audit inline filters:', JSON.stringify(inlineFilters));
        console.log('Audit sort fields:', JSON.stringify(sortFields));
        console.log('Audit pagination:', JSON.stringify(pagination));

        // Execute audit history query
        const result = await auditService.executeAuditHistoryQuery(
            filters,
            pagination,
            inlineFilters,
            sortFields
        );

        if (!result.success) {
            console.error('Audit history query failed:', result.error);
            return next(new Error(result.error));
        }

        console.log('Audit history query completed successfully');
        return res.json(result.data);

    } catch (error) {
        console.error('Error in POST /audit/Audit-history:', error);
        next(error);
    }
});

module.exports = router;