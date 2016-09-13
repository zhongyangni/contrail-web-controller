/*
 * Copyright (c) 2016 Juniper Networks, Inc. All rights reserved.
 */

define([
    'contrail-list-model'
], function (ContrailListModel) {
    var DatabaseNodeCPUMemChartsModel = function () {
        var queryPostData = {
            "autoSort": true,
            "async": false,
            "formModelAttrs": {
              "table_name": "StatTable.NodeStatus.process_mem_cpu_usage",
              "table_type": "STAT",
              "query_prefix": "stat",
              "time_granularity": 150,
              "time_granularity_unit": "secs",
              "from_time": Date.now() - (2 * 60 * 60 * 1000),
              "from_time_utc": Date.now() - (2 * 60 * 60 * 1000),
              "to_time": Date.now(),
              "to_time_utc": Date.now(),
              "select": "name, T=, "+
              "MAX(process_mem_cpu_usage.mem_res), MAX(process_mem_cpu_usage.cpu_share)",
              "where": "process_mem_cpu_usage.__key = cassandra",
              "where_json": null,
              "filter_json": null,
              "direction": "1",
              "filters": "",
              "limit": "150000"
            },
        };
        var listModelConfig = {
            remote : {
                ajaxConfig : {
                    url : "/api/qe/query",
                    type: 'POST',
                    data: JSON.stringify(queryPostData)
                },
                dataParser : function (response) {
                    return response['data'];
                }
            },
            cacheConfig : {}
        };

        return ContrailListModel(listModelConfig);
    };
    return DatabaseNodeCPUMemChartsModel;
    }
);