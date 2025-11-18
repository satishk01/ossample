// models/request-models.js
const Joi = require('joi');

/**
 * Enum for filter conditions
 */
const FilterCondition = {
  EQUALS: '=',
  NOT_EQUALS: '<>',
  GREATER_THAN: '>',
  LESS_THAN: '<',
  GREATER_EQUAL: '>=',
  LESS_EQUAL: '<=',
  IN: 'in',
  NOT_IN: 'not_in'
};

/**
 * Validation schema for field filter with condition and value(s)
 */
const fieldFilterSchema = Joi.object({
  condition: Joi.string()
    .valid(...Object.values(FilterCondition))
    .required()
    .description('Filter condition'),
  value: Joi.alternatives()
    .try(
      Joi.string(),
      Joi.number(),
      Joi.array().items(Joi.alternatives().try(Joi.string(), Joi.number()))
    )
    .required()
    .description('Filter value(s)')
}).custom((obj, helpers) => {
  const { condition, value } = obj;

  if ([FilterCondition.IN, FilterCondition.NOT_IN].includes(condition)) {
    if (!Array.isArray(value)) {
      return helpers.error('custom', { message: 'Condition IN or NOT_IN requires a list of values' });
    }
    if (value.length === 0) {
      return helpers.error('custom', { message: 'Condition IN or NOT_IN requires at least one value' });
    }
  } else if ([
    FilterCondition.EQUALS, 
    FilterCondition.NOT_EQUALS, 
    FilterCondition.GREATER_THAN, 
    FilterCondition.LESS_THAN,
    FilterCondition.GREATER_EQUAL, 
    FilterCondition.LESS_EQUAL
  ].includes(condition)) {
    if (Array.isArray(value)) {
      return helpers.error('custom', { message: 'Condition requires a single value, not a list' });
    }
  }
  
  return obj;
});

/**
 * Validation schema for query filters
 */
const queryFiltersSchema = Joi.object({
  // Existing fields - backward compatibility
  region_code: Joi.array().items(Joi.string()).description('Filter by region codes (backward compatibility)'),
  district_code: Joi.array().items(Joi.string()).description('Filter by district codes (backward compatibility)'),
  dealer_code: Joi.array().items(Joi.string()).description('Filter by dealer codes (backward compatibility)'),
  date_range: Joi.object({
    gte: Joi.string(),
    lte: Joi.string()
  }).description('Date range filter with gte and/or lte keys'),
  
  // New conditional filter fields
  distributor_code: fieldFilterSchema.description('Filter by distributor codes with conditions'),
  region_code_filter: fieldFilterSchema.description('Filter by region codes with conditions'),
  district_code_filter: fieldFilterSchema.description('Filter by district codes with conditions'),
  dealer_code_filter: fieldFilterSchema.description('Filter by dealer codes with conditions'),
  model_year: fieldFilterSchema.description('Filter by model years with conditions'),
  model_code: fieldFilterSchema.description('Filter by model codes with conditions'),
  fleet_flag: fieldFilterSchema.description('Filter by fleet flag with conditions'),
  brand_code: fieldFilterSchema.description('Filter by brand codes with conditions'),
  segment_code: fieldFilterSchema.description('Filter by segment codes with conditions'),
  car_trk_indicator: fieldFilterSchema.description('Filter by car/truck indicator with conditions'),
  dealer_type: fieldFilterSchema.description('Filter by dealer types with conditions'),
  team_lease_indicator: fieldFilterSchema.description('Filter by team lease indicator with conditions'),
  transmissiontype_code: fieldFilterSchema.description('Filter by transmission type codes with conditions'),
  series_name: fieldFilterSchema.description('Filter by series names with conditions'),
  accessory_code: fieldFilterSchema.description('Filter by accessory codes with conditions'),
  exterior_color_code: fieldFilterSchema.description('Filter by exterior color codes with conditions'),
  interior_color_code: fieldFilterSchema.description('Filter by interior color codes with conditions'),
  sls_ccyymm: Joi.array().items(Joi.string()).description('Filter by year-month in CCYYMM format (e.g., "202407")')
});

/**
 * Validation schema for v4 query filters (color inventory data)
 */
const queryFiltersV4Schema = Joi.object({
  // Existing fields - backward compatibility
  region_code: Joi.array().items(Joi.string()).description('Filter by region codes (backward compatibility)'),
  district_code: Joi.array().items(Joi.string()).description('Filter by district codes (backward compatibility)'),
  dealer_code: Joi.array().items(Joi.string()).description('Filter by dealer codes (backward compatibility)'),
  transaction_date: Joi.object({
    gte: Joi.string().optional().description('Start date (yyyy-MM-dd)'),
    lte: Joi.string().optional().description('End date (yyyy-MM-dd)')
  }).optional().description('Transaction date range filter'),
  
  // New conditional filter fields for v4
  distributor_code: fieldFilterSchema.description('Filter by distributor codes with conditions'),
  region_code_filter: fieldFilterSchema.description('Filter by region codes with conditions'),
  district_code_filter: fieldFilterSchema.description('Filter by district codes with conditions'),
  dealer_code_filter: fieldFilterSchema.description('Filter by dealer codes with conditions'),
  model_year: fieldFilterSchema.description('Filter by model years with conditions'),
  model_code: fieldFilterSchema.description('Filter by model codes with conditions'),
  fleet_flag: fieldFilterSchema.description('Filter by fleet flag with conditions'),
  brand_code: fieldFilterSchema.description('Filter by brand codes with conditions'),
  segment_code: fieldFilterSchema.description('Filter by segment codes with conditions'),
  car_trk_indicator: fieldFilterSchema.description('Filter by car/truck indicator with conditions'),
  dealer_type: fieldFilterSchema.description('Filter by dealer types with conditions'),
  team_lease_indicator: fieldFilterSchema.description('Filter by team lease indicator with conditions'),
  transmissiontype_code: fieldFilterSchema.description('Filter by transmission type codes with conditions'),
  series_name: fieldFilterSchema.description('Filter by series names with conditions'),
  grade_code: fieldFilterSchema.description('Filter by grade codes with conditions'),
  // V4 specific fields - removed accessory_code, added new color fields
  drivetrain_code: fieldFilterSchema.description('Filter by drivetrain codes with conditions'),
  exterior_color_code: fieldFilterSchema.description('Filter by exterior color codes with conditions'),
  interior_color_code: fieldFilterSchema.description('Filter by interior color codes with conditions'),
  sls_ccyymm: Joi.array().items(Joi.string()).description('Filter by year-month in CCYYMM format (e.g., "202407")')
});

/**
 * Validation schema for v32 query filters (sales inventory data with color filters)
 */
const queryFiltersV32Schema = Joi.object({
  // Existing fields - backward compatibility
  region_code: Joi.array().items(Joi.string()).description('Filter by region codes (backward compatibility)'),
  district_code: Joi.array().items(Joi.string()).description('Filter by district codes (backward compatibility)'),
  dealer_code: Joi.array().items(Joi.string()).description('Filter by dealer codes (backward compatibility)'),
  transaction_date: Joi.object({
    gte: Joi.string().optional().description('Start date (yyyy-MM-dd)'),
    lte: Joi.string().optional().description('End date (yyyy-MM-dd)')
  }).optional().description('Transaction date range filter'),
  
  // New conditional filter fields for v32
  distributor_code: fieldFilterSchema.description('Filter by distributor codes with conditions'),
  region_code_filter: fieldFilterSchema.description('Filter by region codes with conditions'),
  district_code_filter: fieldFilterSchema.description('Filter by district codes with conditions'),
  dealer_code_filter: fieldFilterSchema.description('Filter by dealer codes with conditions'),
  model_year: fieldFilterSchema.description('Filter by model years with conditions'),
  model_code: fieldFilterSchema.description('Filter by model codes with conditions'),
  fleet_flag: fieldFilterSchema.description('Filter by fleet flag with conditions'),
  brand_code: fieldFilterSchema.description('Filter by brand codes with conditions'),
  segment_code: fieldFilterSchema.description('Filter by segment codes with conditions'),
  car_trk_indicator: fieldFilterSchema.description('Filter by car/truck indicator with conditions'),
  dealer_type: fieldFilterSchema.description('Filter by dealer types with conditions'),
  team_lease_indicator: fieldFilterSchema.description('Filter by team lease indicator with conditions'),
  transmissiontype_code: fieldFilterSchema.description('Filter by transmission type codes with conditions'),
  series_name: fieldFilterSchema.description('Filter by series names with conditions'),
  grade_code: fieldFilterSchema.description('Filter by grade codes with conditions'),
  drivetrain_code: fieldFilterSchema.description('Filter by drivetrain codes with conditions'),
  napc_bu_code: fieldFilterSchema.description('Filter by NAPC BU codes with conditions'),
  // V32 specific color filter fields
  exterior_color_code: fieldFilterSchema.description('Filter by exterior color codes with conditions'),
  interior_color_code: fieldFilterSchema.description('Filter by interior color codes with conditions'),
  sls_ccyymm: Joi.array().items(Joi.string()).description('Filter by year-month in CCYYMM format (e.g., "202407")')
});

/**
 * Validation schema for pagination parameters
 */
const paginationRequestSchema = Joi.object({
  page: Joi.number().integer().min(1).default(1).description('Page number (1-based)'),
  page_size: Joi.number().integer().min(1).max(100).default(10).description('Number of items per page')
});

/**
 * Validation schema for PIP query request with filters and pagination
 */
const pipQueryRequestSchema = Joi.object({
  filters: queryFiltersSchema.optional().description('Query filters'),
  pagination: paginationRequestSchema.default(() => ({ page: 1, page_size: 10 })).description('Pagination parameters')
});

/**
 * Class representing a field filter with condition and value(s)
 */
class FieldFilter {
  constructor(data) {
    this.condition = data.condition;
    this.value = data.value;
  }

  static validate(data) {
    return fieldFilterSchema.validate(data);
  }
}

/**
 * Class representing query filters with conditional operators
 */
class QueryFilters {
  constructor(data = {}) {
    // Copy properties from data to this instance
    Object.assign(this, data);
  }

  static validate(data) {
    return queryFiltersSchema.validate(data);
  }

  toJSON() {
    return Object.fromEntries(
      Object.entries(this).filter(([_, v]) => v !== undefined)
    );
  }
}

/**
 * Class representing v4 query filters with conditional operators (color inventory data)
 */
class QueryFiltersV4 {
  constructor(data = {}) {
    // Copy properties from data to this instance
    Object.assign(this, data);
  }

  static validate(data) {
    return queryFiltersV4Schema.validate(data);
  }

  toJSON() {
    return Object.fromEntries(
      Object.entries(this).filter(([_, v]) => v !== undefined)
    );
  }
}

/**
 * Class representing v32 query filters with conditional operators (sales inventory data with color filters)
 */
class QueryFiltersV32 {
  constructor(data = {}) {
    // Copy properties from data to this instance
    Object.assign(this, data);
  }

  static validate(data) {
    return queryFiltersV32Schema.validate(data);
  }

  toJSON() {
    return Object.fromEntries(
      Object.entries(this).filter(([_, v]) => v !== undefined)
    );
  }
}

/**
 * Class representing pagination parameters
 */
class PaginationRequest {
  constructor(data = {}) {
    this.page = data.page || 1;
    this.page_size = data.page_size || 10;
  }

  static validate(data) {
    return paginationRequestSchema.validate(data);
  }
}

/**
 * Class representing a PIP query request with filters and pagination
 */
class PIPQueryRequest {
  constructor(data = {}) {
    this.filters = data.filters ? new QueryFilters(data.filters) : null;
    this.pagination = new PaginationRequest(data.pagination || {});
  }

  static validate(data) {
    return pipQueryRequestSchema.validate(data);
  }
}

/**
 * Validation schema for v4 PIP query request with filters and pagination
 */
const pipQueryRequestV4Schema = Joi.object({
  filters: queryFiltersV4Schema.optional().description('Query filters for v4'),
  pagination: paginationRequestSchema.default(() => ({ page: 1, page_size: 10 })).description('Pagination parameters')
});

/**
 * Class representing a v4 PIP query request with filters and pagination (color inventory data)
 */
class PIPQueryRequestV4 {
  constructor(data = {}) {
    this.filters = data.filters ? new QueryFiltersV4(data.filters) : null;
    this.pagination = new PaginationRequest(data.pagination || {});
  }

  static validate(data) {
    return pipQueryRequestV4Schema.validate(data);
  }
}

/**
 * Validation schema for v32 PIP query request with filters and pagination
 */
const pipQueryRequestV32Schema = Joi.object({
  filters: queryFiltersV32Schema.optional().description('Query filters for v32'),
  pagination: paginationRequestSchema.default(() => ({ page: 1, page_size: 10 })).description('Pagination parameters')
});

/**
 * Class representing a v32 PIP query request with filters and pagination (sales inventory data with color filters)
 */
class PIPQueryRequestV32 {
  constructor(data = {}) {
    this.filters = data.filters ? new QueryFiltersV32(data.filters) : null;
    this.pagination = new PaginationRequest(data.pagination || {});
  }

  static validate(data) {
    return pipQueryRequestV32Schema.validate(data);
  }
}

module.exports = {
  FilterCondition,
  FieldFilter,
  QueryFilters,
  QueryFiltersV4,
  QueryFiltersV32,
  PaginationRequest,
  PIPQueryRequest,
  PIPQueryRequestV4,
  PIPQueryRequestV32,
  // Schemas for validation
  fieldFilterSchema,
  queryFiltersSchema,
  queryFiltersV4Schema,
  queryFiltersV32Schema,
  paginationRequestSchema,
  pipQueryRequestSchema,
  pipQueryRequestV4Schema,
  pipQueryRequestV32Schema
};

