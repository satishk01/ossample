// models/response-models.js

/**
 * Class representing dealer data
 */
class DealerData {
  constructor(data = {}) {
    this.dealer_code = data.dealer_code || '';
    this.dealer_name = data.dealer_name || '';
    this.region_code = data.region_code || '';
    this.district_code = data.district_code || '';
    this.retail = data.retail || 0;
    this.retail_count = data.retail_count || 0;
    this.vpc_stock = data.vpc_stock || 0;
    this.unbuilt_stock = data.unbuilt_stock || 0;
    this.company_stock = data.company_stock || 0;
    this.dealer_stock = data.dealer_stock || 0;
    this.in_transit_to_other_vpc = data.in_transit_to_other_vpc || 0;
    this.other_vpc_stock = data.other_vpc_stock || 0;
    this.post_process_in_transit_vpc = data.post_process_in_transit_vpc || 0;
    this.pre_process_in_transit_vpc = data.pre_process_in_transit_vpc || 0;
    this.total_stock = data.total_stock || 0;
    this.wholesale = data.wholesale || 0;
    this.sales_availability = data.sales_availability || 0;
    this.days_supply = data.days_supply || 0;
    this.retail_yoy = data.retail_yoy || 0;
    this.retail_mom = data.retail_mom || 0;
    this.retail_obj = data.retail_obj || 0;
    this.wholesale_obj = data.wholesale_obj || 0;
    this.associated_distributors = data.associated_distributors || [];
  }
}

/**
 * Class representing district data with aggregated dealers
 */
class DistrictData {
  constructor(data = {}) {
    this.district_code = data.district_code || '';
    this.district_name = data.district_name || '';
    this.region_code = data.region_code || '';
    
    // District totals
    this.company_stock = data.company_stock || 0;
    this.dealer_stock = data.dealer_stock || 0;
    this.in_transit_to_other_vpc = data.in_transit_to_other_vpc || 0;
    this.other_vpc_stock = data.other_vpc_stock || 0;
    this.post_process_in_transit_vpc = data.post_process_in_transit_vpc || 0;
    this.pre_process_in_transit_vpc = data.pre_process_in_transit_vpc || 0;
    this.total_stock = data.total_stock || 0;
    this.retail = data.retail || 0;
    this.retail_yoy = data.retail_yoy || 0;
    this.retail_mom = data.retail_mom || 0;
    this.retail_obj = data.retail_obj || 0;
    this.wholesale_obj = data.wholesale_obj || 0;
    this.wholesale = data.wholesale || 0;
    this.vpc_stock = data.vpc_stock || 0;
    this.unbuilt_stock = data.unbuilt_stock || 0;
    
    // Child dealers
    this.dealers = (data.dealers || []).map(dealer => 
      dealer instanceof DealerData ? dealer : new DealerData(dealer)
    );
  }
}

/**
 * Class representing region data with aggregated districts
 */
class RegionData {
  constructor(data = {}) {
    this.region_code = data.region_code || '';
    this.region_name = data.region_name || '';
    this.primary_distributor = data.primary_distributor || '';
    
    // Region totals
    this.company_stock = data.company_stock || 0;
    this.dealer_stock = data.dealer_stock || 0;
    this.in_transit_to_other_vpc = data.in_transit_to_other_vpc || 0;
    this.other_vpc_stock = data.other_vpc_stock || 0;
    this.post_process_in_transit_vpc = data.post_process_in_transit_vpc || 0;
    this.pre_process_in_transit_vpc = data.pre_process_in_transit_vpc || 0;
    this.total_stock = data.total_stock || 0;
    this.retail = data.retail || 0;
    this.retail_yoy = data.retail_yoy || 0;
    this.retail_mom = data.retail_mom || 0;
    this.retail_obj = data.retail_obj || 0;
    this.wholesale_obj = data.wholesale_obj || 0;
    this.wholesale = data.wholesale || 0;
    this.vpc_stock = data.vpc_stock || 0;
    this.unbuilt_stock = data.unbuilt_stock || 0;
    
    // Child districts
    this.districts = (data.districts || []).map(district => 
      district instanceof DistrictData ? district : new DistrictData(district)
    );
  }
}

/**
 * Class representing pagination information
 */
class PaginationInfo {
  constructor(data = {}) {
    this.current_page = data.current_page || 1;
    this.page_size = data.page_size || 10;
    this.total_regions = data.total_regions || 0;
    this.total_pages = data.total_pages || 0;
    this.regions_in_current_page = data.regions_in_current_page || 0;
    this.has_next_page = data.has_next_page || false;
    this.has_previous_page = data.has_previous_page || false;
    this.current_page_regions = data.current_page_regions || [];
    this.region_range = data.region_range || '';
  }
}

/**
 * Class representing query execution information
 */
class QueryInfo {
  constructor(data = {}) {
    this.took = data.took || 0;
    this.timed_out = data.timed_out || false;
    this.total_shards = data.total_shards || 0;
    this.successful_shards = data.successful_shards || 0;
  }
}

/**
 * Class representing a PIP query response with hierarchical data
 */
class PIPQueryResponse {
  constructor(data = {}) {
    this.success = data.success || false;
    this.pagination = data.pagination instanceof PaginationInfo 
      ? data.pagination 
      : new PaginationInfo(data.pagination || {});
    
    this.total_aggregated_dealers = data.total_aggregated_dealers || 0;
    this.unique_dealers_count = data.unique_dealers_count || 0;
    this.duplicate_dealers = data.duplicate_dealers || {};
    
    // Check if this is v2 data (has version property or v2-specific fields)
    if (data.version === "v2" || data.aggregation_level === "dealer_to_region") {
      // For v2, don't transform the data - keep it as-is to preserve field names
      this.data = data.data || [];
      this.version = "v2";
      this.aggregation_level = data.aggregation_level;
    } else {
      // For v1, use the model transformation
      this.data = (data.data || []).map(region => 
        region instanceof RegionData ? region : new RegionData(region)
      );
    }
    
    this.query_info = data.query_info instanceof QueryInfo
      ? data.query_info
      : new QueryInfo(data.query_info || {});
      
    this.execution_timestamp = data.execution_timestamp || new Date();
    this.error = data.error || null;
  }
}

/**
 * Class representing a PIP query response for v3 (accessory data) with hierarchical data
 */
class PIPQueryResponseV3 {
  constructor(data = {}) {
    this.success = data.success || false;
    this.pagination = data.pagination instanceof PaginationInfo 
      ? data.pagination 
      : new PaginationInfo(data.pagination || {});
    
    this.total_aggregated_dealers = data.total_aggregated_dealers || 0;
    this.unique_dealers_count = data.unique_dealers_count || 0;
    this.duplicate_dealers = data.duplicate_dealers || {};
    
    // For v3, don't transform the data - keep it as-is to preserve field names
    this.data = data.data || [];
    this.version = "v3";
    this.aggregation_level = data.aggregation_level || "dealer_to_region_accessory";
    
    this.query_info = data.query_info instanceof QueryInfo
      ? data.query_info
      : new QueryInfo(data.query_info || {});
      
    this.execution_timestamp = data.execution_timestamp || new Date();
    this.error = data.error || null;
  }
}

/**
 * Class representing a PIP query response for v4 (color inventory data) with hierarchical data
 */
class PIPQueryResponseV4 {
  constructor(data = {}) {
    this.success = data.success || false;
    this.pagination = data.pagination instanceof PaginationInfo 
      ? data.pagination 
      : new PaginationInfo(data.pagination || {});
    
    this.total_aggregated_dealers = data.total_aggregated_dealers || 0;
    this.unique_dealers_count = data.unique_dealers_count || 0;
    this.duplicate_dealers = data.duplicate_dealers || {};
    
    // For v4, don't transform the data - keep it as-is to preserve field names
    this.data = data.data || [];
    this.version = "v4";
    this.aggregation_level = data.aggregation_level || "dealer_to_region_color_inventory";
    
    this.query_info = data.query_info instanceof QueryInfo
      ? data.query_info
      : new QueryInfo(data.query_info || {});
      
    this.execution_timestamp = data.execution_timestamp || new Date();
    this.error = data.error || null;
  }
}

/**
 * Class representing a PIP query response for v32 (sales inventory data with color filters) with hierarchical data
 */
class PIPQueryResponseV32 {
  constructor(data = {}) {
    this.success = data.success || false;
    this.pagination = data.pagination instanceof PaginationInfo 
      ? data.pagination 
      : new PaginationInfo(data.pagination || {});
    
    this.total_aggregated_dealers = data.total_aggregated_dealers || 0;
    this.unique_dealers_count = data.unique_dealers_count || 0;
    this.duplicate_dealers = data.duplicate_dealers || {};
    
    // For v32, don't transform the data - keep it as-is to preserve field names
    this.data = data.data || [];
    this.version = "v32";
    this.aggregation_level = data.aggregation_level || "flat_dealer_aggregation_sales_inventory";
    
    this.query_info = data.query_info instanceof QueryInfo
      ? data.query_info
      : new QueryInfo(data.query_info || {});
      
    this.execution_timestamp = data.execution_timestamp || new Date();
    this.error = data.error || null;
  }
}

/**
 * Class representing pagination summary response
 */
class PaginationSummaryResponse {
  constructor(data = {}) {
    this.success = data.success || false;
    this.total_regions = data.total_regions || 0;
    this.regions = data.regions || [];
    this.suggested_page_size = data.suggested_page_size || 5;
    this.total_pages_with_5_per_page = data.total_pages_with_5_per_page || 0;
    this.total_pages_with_10_per_page = data.total_pages_with_10_per_page || 0;
    this.error = data.error || null;
  }
}

module.exports = {
  DealerData,
  DistrictData,
  RegionData,
  PaginationInfo,
  QueryInfo,
  PIPQueryResponse,
  PIPQueryResponseV3,
  PIPQueryResponseV4,
  PIPQueryResponseV32,
  PaginationSummaryResponse
};

