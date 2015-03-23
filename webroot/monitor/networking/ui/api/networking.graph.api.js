/*
 * Copyright (c) 2014 Juniper Networks, Inc. All rights reserved.
 */

module.exports

var cacheApi = require(process.mainModule.exports["corePath"] + '/src/serverroot/web/core/cache.api'),
    global = require(process.mainModule.exports["corePath"] + '/src/serverroot/common/global'),
    messages = require(process.mainModule.exports["corePath"] + '/src/serverroot/common/messages'),
    commonUtils = require(process.mainModule.exports["corePath"] + '/src/serverroot/utils/common.utils'),
    config = process.mainModule.exports["config"],
    rest = require(process.mainModule.exports["corePath"] + '/src/serverroot/common/rest.api'),
    async = require('async'),
    jsonPath = require('JSONPath').eval,
    opApiServer = require(process.mainModule.exports["corePath"] + '/src/serverroot/common/opServer.api'),
    configApiServer = require(process.mainModule.exports["corePath"] + '/src/serverroot/common/configServer.api'),
    infraCmn = require('../../../../common/api/infra.common.api'),
    logutils = require(process.mainModule.exports["corePath"] + '/src/serverroot/utils/log.utils'),
    nwMonUtils = require('../../../../common/api/nwMon.utils'),
    appErrors = require(process.mainModule.exports["corePath"] + '/src/serverroot/errors/app.errors'),
    assert = require('assert'),
    authApi = require(process.mainModule.exports["corePath"] + '/src/serverroot/common/auth.api');

var opServer = rest.getAPIServer({
    apiName: global.label.OPS_API_SERVER,
    server: config.analytics.server_ip,
    port: config.analytics.server_port
});

function vnLinkListed(srcVN, dstVN, dir, vnNodeList) {
    var cnt = vnNodeList.length;
    for (var i = 0; i < cnt; i++) {
        if (((vnNodeList[i]['src'] == srcVN) &&
            (vnNodeList[i]['dst'] == dstVN)) ||
            ((vnNodeList[i]['src'] == dstVN) &&
            (vnNodeList[i]['dst'] == srcVN))) {
            if (dir != vnNodeList[i]['dir']) {
                vnNodeList[i]['error'] =
                    'Other link marked as ' + dir +
                    'directional, attach policy';
            }
            return i;
        }
    }
    return -1;
}

function vnNameListed(vnName, nodes, fqName) {
    var cnt = nodes.length;
    for (var i = 0; i < cnt; i++) {
        if (vnName == nodes[i]['name']) {
            return true;
        }
    }
    return false;
}

function ifLinkStatExists(srcVN, dstVN, stats, resultJSON) {
    var cnt = stats.length;
    for (var i = 0; i < cnt; i++) {
        if ((srcVN == stats[i]['src']) &&
            (dstVN == stats[i]['dst'])) {
            resultJSON['error'] =
                'Other link marked as ' +
                'unidirectional, attach policy';
            return true;
        }
    }
    return false;
}

function getLinkStats(resultJSON, vnUVENode, vn, result) {
    var j = 0;
    var inStats = jsonPath(vnUVENode, "$..in_stats");

    if (inStats.length > 0) {
        if (null == resultJSON['in_stats']) {
            resultJSON['in_stats'] = [];
            j = 0;
        } else {
            j = resultJSON['in_stats'].length;
        }
        var len = inStats[0].length;
        for (var i = 0; i < len; i++) {
            if (ifLinkStatExists(vnUVENode['name'], vn,
                    resultJSON['in_stats'], result)) {
                continue;
            }
            if (inStats[0][i]['other_vn'] == vn) {
                resultJSON['in_stats'][j] = {};
                resultJSON['in_stats'][j]['src'] = vnUVENode['name'];
                resultJSON['in_stats'][j]['dst'] = vn;
                resultJSON['in_stats'][j]['pkts'] = inStats[0][i]['tpkts'];
                resultJSON['in_stats'][j]['bytes'] = inStats[0][i]['bytes'];
                j++;
                break;
            }
        }
    }
    j = 0;
    var outStats = jsonPath(vnUVENode, "$..out_stats");
    if (outStats.length > 0) {
        if (null == resultJSON['out_stats']) {
            resultJSON['out_stats'] = [];
            j = 0;
        } else {
            j = resultJSON['out_stats'].length;
        }
        len = outStats[0].length;
        for (i = 0; i < len; i++) {
            if (ifLinkStatExists(vnUVENode['name'], vn,
                    resultJSON['out_stats'], result)) {
                continue;
            }
            if (outStats[0][i]['other_vn'] == vn) {
                resultJSON['out_stats'][j] = {};
                resultJSON['out_stats'][j]['src'] = vnUVENode['name'];
                resultJSON['out_stats'][j]['dst'] = vn;
                resultJSON['out_stats'][j]['pkts'] = outStats[0][i]['tpkts'];
                resultJSON['out_stats'][j]['bytes'] = outStats[0][i]['bytes'];
                j++;
                break;
            }
        }
    }
    return resultJSON;
}

function getVNPolicyRuleDirection(dir) {
    if (dir == '<>') {
        return 'bi';
    } else {
        return 'uni';
    }
}


function vnOrSIConfigExist(fqName, configData) {
    try {
        var configDataCnt = configData.length;
    } catch (e) {
        return false;
    }
    for (var i = 0; i < configDataCnt; i++) {
        try {
            var configNode = configData[i]['fq_name'].join(':');
            if (configNode == fqName) {
                break;
            }
        } catch (e) {
        }
    }
    if (i == configDataCnt) {
        return false;
    }
    return true;
}

function parseAndGetMissingVNsUVEs(fqName, vnUVE, callback) {
    var resultJSON = [];
    var insertedVNObjs = {};
    var urlList = [];
    var index = 0;
    var vnCnt = vnUVE.length;
    var addNew = false;
    var dataObjArr = [];
    var arrIndex = 0;
    var url = '/analytics/uves/virtual-network/*?kfilt=';

    for (var i = 0; i < vnCnt; i++) {
        vnName = vnUVE[i]['name'];
        if (false == isAllowedVN(fqName, vnName)) {
            continue;
        }
        pos = vnName.indexOf(fqName);
        if (pos != -1) {
            if (insertedVNObjs[vnName] == null) {
                insertedVNObjs[vnName] = vnName;
                resultJSON[index++] = vnUVE[i];
            }
            var partConnNws = jsonPath(vnUVE[i],
                "$..partially_connected_networks");
            if (partConnNws.length > 0) {
                var len = partConnNws[0].length;
                for (var j = 0; j < len; j++) {
                    partConnVN = partConnNws[0][j];
                    if ((insertedVNObjs[partConnVN] == null) &&
                        (false == isServiceVN(partConnVN))) {
                        insertedVNObjs[partConnVN] = partConnVN;
                        if (false == isAllowedVN(fqName, partConnVN)) {
                            url = getNetworkTopoMissingVNsURL(arrIndex, url,
                                partConnVN);
                            arrIndex++;
                        } else {
                            resultJSON[index++] = getVNUVEByVNName(vnUVE,
                                partConnVN);
                        }
                    }
                }
            }
            var connNws = jsonPath(vnUVE[i], "$..connected_networks");
            if (connNws.length > 0) {
                len = connNws[0].length;
                for (j = 0; j < len; j++) {
                    connVN = connNws[0][j];
                    if ((insertedVNObjs[connVN] == null) &&
                        (false == isServiceVN(connVN))) {
                        insertedVNObjs[connVN] = connVN;
                        if (false == isAllowedVN(fqName, connVN)) {
                            url = getNetworkTopoMissingVNsURL(arrIndex, url, connVN);
                            arrIndex++;
                        } else {
                            resultJSON[index++] = getVNUVEByVNName(vnUVE, connVN);
                        }
                    }
                }
            }
        }
    }
    if (!arrIndex) {
        /* All VNs are included */
        callback(null, resultJSON);
        return;
    }
    var postData = {};
    var kfiltArr = url.split('/*?kfilt=');
    url = kfiltArr[0];
    if (kfiltArr[1]) {
        postData['kfilt'] = kfiltArr[1].split(',');
    }
    opServer.api.post(url, postData, function (err, data) {
        if (err || (null == data)) {
            logutils.logger.error('In Network Topology: we did not get data ' +
            'for: ' + url);
            callback(null, resultJSON);
            return;
        }
        var len = resultJSON.length;
        data = data['value'];
        var newCnt = data.length;
        for (var i = 0; i < newCnt; i++) {
            resultJSON[len + i] = data[i];
        }
        callback(null, resultJSON);
    });
};

function getVNUVEByVNName(vnUVEs, vnName) {
    var uve = {};
    uve['name'] = vnName;
    uve['value'] = {};
    var cnt = vnUVEs.length;
    for (var i = 0; i < cnt; i++) {
        if (vnUVEs[i]['name'] == vnName) {
            return vnUVEs[i];
        }
    }
    return uve;
}

function isAllowedVN(fqName, vnName) {
    if ((null == vnName) || (null == fqName)) {
        return false;
    }

    if (true == isServiceVN(vnName)) {
        return false;
    }

    var vnNameArr = vnName.split(':');
    var fqNameArr = fqName.split(':');
    var fqLen = fqNameArr.length;
    if (3 == fqLen) {
        /* VN */
        if (fqName == vnName) {
            return true;
        }
    } else if (2 == fqLen) {
        /* Project */
        if ((vnNameArr[0] == fqNameArr[0]) && (vnNameArr[1] == fqNameArr[1])) {
            return true;
        }
    } else if (1 == fqLen) {
        if ('*' == fqNameArr[0]) {
            return true;
        }
        if (vnNameArr[0] == fqNameArr[0]) {
            return true;
        }
    }
    return false;
}

function updateMissingVNsByConfig(fqName, nwTopoData, configData) {
    var nwList = {};
    try {
        var vnConfig = configData['virtual-networks'];
        var vnConfigCnt = vnConfig.length;
    } catch (e) {
        return nwTopoData;
    }
    try {
        var nodesCnt = nwTopoData['nodes'].length;
    } catch (e) {
        nwTopoData = {};
        nwTopoData['nodes'] = [];
        nodesCnt = 0;
    }
    try {
        var linkCnt = nwTopoData['links'].length;
    } catch (e) {
        nwTopoData['links'] = [];
    }

    for (var i = 0; i < nodesCnt; i++) {
        var vn = nwTopoData['nodes'][i]['name'];
        if (vn) {
            nwList[vn] = vn;
        }
    }
    for (i = 0; i < vnConfigCnt; i++) {
        try {
            var vn = vnConfig[i]['fq_name'].join(':');
            if ((nwList[vn] == null) &&
                (true == isAllowedVN(fqName, vn))) {
                nwTopoData['nodes'][nodesCnt++] = createNWTopoVNNode(vn, "Active");
            }
        } catch (e) {
            continue;
        }
    }
    return nwTopoData;
}

function getNetworkTopoMissingVNsURL(arrIndex, url, vn) {
    if (!arrIndex) {
        /* First element in kfilt */
        url += vn;
    } else {
        url += ',' + vn;
    }
    return url;
}

function makeBulkDataByFqn(fqName, data) {
    var tempArr = fqName.split(':');
    if (tempArr.length == 3) {
        /* Exact VN, now change the data format */
        var tempData = {};
        tempData['value'] = [];
        tempData['value'][0] = {};
        tempData['value'][0]['name'] = fqName;
        tempData['value'][0]['value'] = commonUtils.cloneObj(data);
        data = tempData;
    }
    return data;
}

function parseServiceChainUVE(fqName, resultJSON, scUVE) {
    var cnt = scUVE.length;
    for (var i = 0; i < cnt; i++) {
        resultJSON = getServiceChainNode(fqName, resultJSON, scUVE[i]);
    }
    return resultJSON;
}

function parseVirtualNetworkUVE(fqName, vnUVE) {
    var resultJSON = {};
    resultJSON['nodes'] = [];
    resultJSON['links'] = [];

    var vnCnt = vnUVE.length;
    for (var i = 0; i < vnCnt; i++) {
        resultJSON = getVirtualNetworkNode(fqName, resultJSON, vnUVE[i]);
    }
    return resultJSON;
}

function updateVNStatsBySIData(scResultJSON, vnUVE) {
    try {
        var links = scResultJSON['links'];
        var linksCnt = links.length;
    } catch (e) {
        return scResultJSON;
    }

    for (var i = 0; i < linksCnt; i++) {
        if (null == links[i]['service_inst']) {
            continue;
        }
        if (getVNStatsBySIData(scResultJSON['links'][i], scResultJSON, vnUVE)) {
            i = -1;
            linksCnt--;
        }
    }
    return scResultJSON;
}

function getVNStatsBySIData(links, scResultJSON, vnUVE) {
    var src = links['src'];
    var dst = links['dst'];
    var dir = links['dir'];

    try {
        var scLinks = scResultJSON['links'];
        var linksCnt = scLinks.length;

        for (var i = 0; i < linksCnt; i++) {
            try {
                if (null == scLinks[i]['service_inst']) {
                    if (((scResultJSON['links'][i]['src'] == links['src']) &&
                        (scResultJSON['links'][i]['dst'] == links['dst'])) ||
                        ((scResultJSON['links'][i]['src'] == links['dst']) &&
                        (scResultJSON['links'][i]['dst'] == links['src']))) {
                        links['more_attributes'] =
                            scResultJSON['links'][i]['more_attributes'];
                        scResultJSON['links'].splice(i, 1);
                        return 1;
                    }
                }
            } catch (e) {
                continue;
            }
        }
    } catch (e) {
    }
    /* Now check if we have any stat in UVE */
    var srcVNUVE = getVNUVEByVNName(vnUVE, links['src']);
    var destVNUVE = getVNUVEByVNName(vnUVE, links['dst']);

    links['more_attributes'] = {};
    getVNStats(links, srcVNUVE, "in_stats", links['src'], links['dst']);
    getVNStats(links, srcVNUVE, "out_stats", links['src'], links['dst']);
    getVNStats(links, destVNUVE, "in_stats", links['dst'], links['src']);
    getVNStats(links, destVNUVE, "out_stats", links['dst'], links['src']);
    return 0;
}

function getVNStats(links, vnUVE, jsonP, src, dest) {
    var stats = jsonPath(vnUVE, "$.." + jsonP);
    if (stats.length > 0) {
        stats = stats[0];
        statsCnt = stats.length
        for (var i = 0; i < statsCnt; i++) {
            if (stats[i]['other_vn'] == dest) {
                if (null == links['more_attributes'][jsonP]) {
                    links['more_attributes'][jsonP] = [];
                    cnt = 0;
                } else {
                    cnt = links['more_attributes'][jsonP].length;
                }
                links['more_attributes'][jsonP][cnt] = {};
                links['more_attributes'][jsonP][cnt]['src'] = src;
                links['more_attributes'][jsonP][cnt]['dst'] = dest;
                links['more_attributes'][jsonP][cnt]['pkts'] =
                    stats[i]['tpkts'];
                links['more_attributes'][jsonP][cnt]['bytes'] =
                    stats[i]['bytes'];
                break;
            }
        }
    }
}

function getVirtualNetworkNode(fqName, resultJSON, vnUVENode) {
    var i = 0, j = 0;

    var nodeCnt = resultJSON['nodes'].length;
    var linkCnt = resultJSON['links'].length;

    resultJSON['nodes'][nodeCnt] = {};
    resultJSON['nodes'][nodeCnt]['name'] = vnUVENode['name'];
    resultJSON['nodes'][nodeCnt]['more_attr'] = {};
    try {
        var inBytes = jsonPath(vnUVENode, "$..in_bytes");
        if (inBytes.length > 0) {
            inBytes = inBytes[0];
        } else {
            inBytes = 0;
        }
        resultJSON['nodes'][nodeCnt]['more_attr']['in_bytes'] = inBytes;
    } catch (e) {
        resultJSON['nodes'][nodeCnt]['more_attr']['in_bytes'] = 0;
    }
    try {
        var inPkts = jsonPath(vnUVENode, "$..in_tpkts");
        if (inPkts.length > 0) {
            inPkts = inPkts[0];
        } else {
            inPkts = 0;
        }
        resultJSON['nodes'][nodeCnt]['more_attr']['in_tpkts'] = inPkts;
    } catch (e) {
        resultJSON['nodes'][nodeCnt]['more_attr']['in_tpkts'] = 0;
    }
    try {
        var outBytes = jsonPath(vnUVENode, "$..out_bytes");
        if (outBytes.length > 0) {
            outBytes = outBytes[0];
        } else {
            outBytes = 0;
        }
        resultJSON['nodes'][nodeCnt]['more_attr']['out_bytes'] = outBytes;
    } catch (e) {
        resultJSON['nodes'][nodeCnt]['more_attr']['out_bytes'] = 0;
    }
    try {
        var outPkts = jsonPath(vnUVENode, "$..out_tpkts");
        if (outPkts.length > 0) {
            outPkts = outPkts[0];
        } else {
            outPkts = 0;
        }
        resultJSON['nodes'][nodeCnt]['more_attr']['out_tpkts'] = outPkts;
    } catch (e) {
        resultJSON['nodes'][nodeCnt]['more_attr']['out_tpkts'] = 0;
    }
    try {
        var vmList = jsonPath(vnUVENode, "$..virtualmachine_list");
        if (vmList.length > 0) {
            vmCnt = vmList[0].length;
            resultJSON['nodes'][nodeCnt]['more_attr']['virtualmachine_list'] = vmList[0];
        } else {
            vmCnt = 0;
        }
        resultJSON['nodes'][nodeCnt]['more_attr']['vm_cnt'] = vmCnt;
    } catch (e) {
        resultJSON['nodes'][nodeCnt]['more_attr']['vm_cnt'] = 0;
        resultJSON['nodes'][nodeCnt]['more_attr']['virtualmachine_list'] = [];
    }
    try {
        var interfaceList = jsonPath(vnUVENode, "$..interface_list");
        if (interfaceList.length > 0) {
            resultJSON['nodes'][nodeCnt]['more_attr']['interface_list'] = interfaceList[0];
        }
    } catch (e) {
        resultJSON['nodes'][nodeCnt]['more_attr']['interface_list'] = [];
    }
    try {
        var attachedPolicies = jsonPath(vnUVENode, "$..attached_policies");
        if (attachedPolicies.length > 0) {
            resultJSON['nodes'][nodeCnt]['more_attr']['attached_policies'] = attachedPolicies[0];
        }
    } catch (e) {
        resultJSON['nodes'][nodeCnt]['more_attr']['attached_policies'] = [];
    }
    try {
        var fipCnt = jsonPath(vnUVENode, "$..associated_fip_count");
        if (fipCnt.length > 0) {
            fipCnt = fipCnt[0];
        } else {
            fipCnt = 0;
        }
        resultJSON['nodes'][nodeCnt]['more_attr']['fip_cnt'] = fipCnt;
    } catch (e) {
        resultJSON['nodes'][nodeCnt]['more_attr']['fip_cnt'] = 0;
    }

    var partConnNws = jsonPath(vnUVENode, "$..partially_connected_networks");
    if (partConnNws.length > 0) {
        var len = partConnNws[0].length;
        var k = 0;
        for (var i = 0; i < len; i++) {
            if (((-1 == (vnUVENode['name']).indexOf(fqName)) &&
                (-1 == (partConnNws[0][i]).indexOf(fqName))) ||
                (true == isServiceVN(vnUVENode['name'])) ||
                (true == isServiceVN(partConnNws[0][i]))) {
                continue;
            }
            var index = vnLinkListed(vnUVENode['name'], partConnNws[0][i],
                'uni', resultJSON['links']);
            if (-1 != index) {
                getLinkStats(resultJSON['links'][index]['more_attributes'],
                    vnUVENode, partConnNws[0][i],
                    resultJSON['links'][index]);
                continue;
            }
            index = linkCnt + j;
            resultJSON['links'][index] = {};
            resultJSON['links'][index]['src'] = vnUVENode['name'];
            resultJSON['links'][index]['dst'] = partConnNws[0][i];
            resultJSON['links'][index]['dir'] = 'uni';
            resultJSON['links'][index]['more_attributes'] = {};
            getLinkStats(resultJSON['links'][index]['more_attributes'],
                vnUVENode, partConnNws[0][i],
                resultJSON['links'][index]);
            resultJSON['links'][index]['error'] = 'Other link marked as ' +
            'unidirectional, attach policy';
            j++;
        }
    }
    var linkCnt = resultJSON['links'].length;
    var connNws = jsonPath(vnUVENode, "$..connected_networks");
    if (connNws.length > 0) {
        var len = connNws[0].length;
        j = 0, k = 0;
        resultJSON['nodes'][nodeCnt]['more_attr']['connected_networks'] = connNws;
        for (var i = 0; i < len; i++) {
            if ((-1 == (vnUVENode['name']).indexOf(fqName)) || (true == isServiceVN(vnUVENode['name'])) || (true == isServiceVN(connNws[0][i]))) {
                continue;
            }
            var index = vnLinkListed(vnUVENode['name'], connNws[0][i], 'bi', resultJSON['links']);
            if (-1 != index) {
                getLinkStats(resultJSON['links'][index]['more_attributes'], vnUVENode, connNws[0][i], resultJSON['links'][index]);
                continue;
            }
            resultJSON['links'][linkCnt + j] = {};
            resultJSON['links'][linkCnt + j]['src'] = vnUVENode['name'];
            resultJSON['links'][linkCnt + j]['dst'] = connNws[0][i];
            resultJSON['links'][linkCnt + j]['dir'] = 'bi';
            resultJSON['links'][linkCnt + j]['more_attributes'] = {};
            getLinkStats(resultJSON['links'][linkCnt + j]['more_attributes'], vnUVENode, connNws[0][i], resultJSON['links'][index]);
            j++;
        }
    }
    var nodeCnt = resultJSON['nodes'].length;
    for (i = 0; i < nodeCnt; i++) {
        resultJSON['nodes'][i]['node_type'] =
            global.STR_NODE_TYPE_VIRTUAL_NETWORK;
    }
    return resultJSON;
}

function getServiceChainNode(fqName, resultJSON, scUVENode) {
    var nodeCnt = resultJSON['nodes'].length,
        linkCnt = resultJSON['links'].length,
        j = 0;

    var srcVN = scUVENode['value']['UveServiceChainData']['source_virtual_network'],
        destVN = scUVENode['value']['UveServiceChainData']['destination_virtual_network'];

    if ((false == isAllowedVN(fqName, srcVN)) && (false == isAllowedVN(fqName, destVN))) {
        return resultJSON;
    }

    var found = vnNameListed(srcVN, resultJSON['nodes']);
    if (false == found) {
        if (true == isServiceVN(srcVN)) {
            return;
        }
        resultJSON['nodes'][nodeCnt + j] = {};
        resultJSON['nodes'][nodeCnt + j]['name'] = srcVN;
        resultJSON['nodes'][nodeCnt + j]['node_type'] = global.STR_NODE_TYPE_VIRTUAL_NETWORK;
        j++;
    }
    var found = vnNameListed(destVN, resultJSON['nodes']);
    if (false == found) {
        if (true == isServiceVN(destVN)) {
            return;
        }
        resultJSON['nodes'][nodeCnt + j] = {};
        resultJSON['nodes'][nodeCnt + j]['name'] = destVN;
        resultJSON['nodes'][nodeCnt + j]['node_type'] = global.STR_NODE_TYPE_VIRTUAL_NETWORK;
        j++;
    }

    var services = jsonPath(scUVENode, "$..services");
    services = services[0];
    var svcCnt = services.length;
    var nodeCnt = resultJSON['nodes'].length;

    j = 0;
    resultJSON['links'][linkCnt] = {};
    resultJSON['links'][linkCnt]['src'] = srcVN;
    resultJSON['links'][linkCnt]['dst'] = destVN;
    resultJSON['links'][linkCnt]['more_attributes'] = {};
    resultJSON['links'][linkCnt]['service_inst'] = services;
    resultJSON['links'][linkCnt]['dir'] = getVNPolicyRuleDirection(scUVENode['value']['UveServiceChainData']['direction']);

    for (var i = 0; i < svcCnt; i++) {
        found = vnNameListed(services[i], resultJSON['nodes']);
        if (false == found) {
            resultJSON['nodes'][nodeCnt + j] = {};
            resultJSON['nodes'][nodeCnt + j]['name'] = services[i];
            resultJSON['nodes'][nodeCnt + j]['node_type'] = global.STR_NODE_TYPE_SERVICE_CHAIN;
            j++;
        }
    }
    return resultJSON;
}

function updateVNNodeStatus(result, configVN, configSI, fqName) {
    var nodes = result['nodes'];
    var nodeCnt = nodes.length;
    var found = false;

    for (var i = 0; i < nodeCnt; i++) {
        var node = result['nodes'][i]['name'];
        var nodeType = result['nodes'][i]['node_type'];
        if (global.STR_NODE_TYPE_VIRTUAL_NETWORK == nodeType) {
            found = vnOrSIConfigExist(node, configVN);
        } else {
            found = vnOrSIConfigExist(node, configSI);
        }
        if (found == false) {
            result['nodes'][i]['status'] = 'Deleted';
        } else {
            result['nodes'][i]['status'] = 'Active';
        }
    }
    var links = result['links'];
    var linkCnt = links.length;
    for (var i = 0; i < linkCnt; i++) {
        if ((false == isAllowedVN(fqName, links[i]['src'])) &&
            (false == isAllowedVN(fqName, links[i]['dst']))) {
            result['links'].splice(i, 1);
            i = -1;
            linkCnt--;
        }
        if ((links[i]['more_attributes']['in_stats']) &&
            (links[i]['more_attributes']['out_stats'])) {
            result['links'][i]['dir'] = 'bi';
        } else {
            result['links'][i]['dir'] = 'uni';
        }
    }
}

function createNWTopoVNNode(vnName, status) {
    var node = {};
    node['name'] = vnName;
    node['more_attr'] = {};
    node['node_type'] = global.STR_NODE_TYPE_VIRTUAL_NETWORK;
    node['status'] = status;
    return node;
}

function setAssociatedPolicys4Network(fqName, scResultJSON) {
    var nodes = scResultJSON['nodes'],
        node, i, attachedPolicies, networkPolicys = [];
    for (i = 0; i < nodes.length; i++) {
        node = nodes[i];
        if (node['name'] == fqName && node['node_type'] == global.STR_NODE_TYPE_VIRTUAL_NETWORK) {
            attachedPolicies = node['more_attr']['attached_policies'];
            for (var j = 0; attachedPolicies != null && j < attachedPolicies.length; j++) {
                networkPolicys.push({"fq_name": (attachedPolicies[j]['vnp_name']).split(":")});
            }
            scResultJSON['configData']['network-policys'] = networkPolicys;
        }
    }
}

function updatePolicyConfigData(configGraphJSON, appData, callback) {
    var reqUrl = null, dataObjArr = [],
        policys, policyCount;

    try {
        policys = configGraphJSON['configData']['network-policys'];
        policyCount = policys.length;
        for (var i = 0; i < policyCount; i++) {
            reqUrl = '/network-policy/' + policys[i]['uuid'];
            commonUtils.createReqObj(dataObjArr, reqUrl, global.HTTP_REQUEST_GET, null, null, null, appData);
        }
    } catch (e) {
        callback(configGraphJSON);
        return;
    }

    async.map(dataObjArr, commonUtils.getServerResponseByRestApi(configApiServer, false), function (err, data) {
        for (var j = 0; j < data.length; j++) {
            try {
                var npEntries = data[j]['network-policy']['network_policy_entries'];
                policys[j]['network_policy_entries'] = npEntries;
            } catch (error) {
                policys[j]['network_policy_entries'] = {'policy_rule': []};
            }
        }
        callback(configGraphJSON);
    });
}

function updateServiceInstanceConfigData(scResultJSON, siConfig, appData, callback) {
    var reqUrl = null;
    var dataObjArr = [];

    try {
        var links = scResultJSON['links'];
        var linkCnt = links.length;
        var siConfigCnt = siConfig.length;
    } catch (e) {
        callback(scResultJSON);
        return;
    }
    var urlLists = [];
    var storedSIList = {};

    for (var i = 0, l = 0; i < linkCnt; i++) {
        try {
            var svcCnt = links[i]['service_inst'].length;
        } catch (e) {
            continue;
        }
        for (var j = 0; j < svcCnt; j++) {
            if (null != storedSIList[links[i]['service_inst'][j]]) {
                /* Already taken */
                continue;
            }
            for (var k = 0; k < siConfigCnt; k++) {
                var fqn = siConfig[k]['fq_name'].join(':');
                if (fqn == links[i]['service_inst'][j]) {
                    storedSIList[fqn] = fqn;
                    reqUrl = '/service-instance/' +
                    siConfig[k]['uuid'];
                    commonUtils.createReqObj(dataObjArr, reqUrl,
                        global.HTTP_REQUEST_GET,
                        null, null, null,
                        appData);
                }
            }
        }
    }
    async.map(dataObjArr,
        commonUtils.getServerResponseByRestApi(configApiServer, false),
        function (err, data) {
            scResultJSON['configData']['service-instances'] = data;
            callback(scResultJSON);
        });
}

function isServiceVN(vnName) {
    if (null == isServiceVN) {
        return false;
    }
    var vnNameArr = vnName.split(':');
    var vnNameLen = vnNameArr.length;

    if (3 != vnNameLen) {
        return false;
    }
    if ((-1 == vnNameArr[2].indexOf('svc-vn-right')) &&
        (-1 == vnNameArr[2].indexOf('svc-vn-left')) &&
        (-1 == vnNameArr[2].indexOf('svc-vn-mgmt'))) {
        return false;
    }
    return true;
}

function getProjectFQN4Network(networkFQN) {
    var networkFQNArray = networkFQN.split(":");
    if (networkFQNArray.length == 3) {
        return networkFQNArray[0] + ":" + networkFQNArray[1];
    } else {
        return null;
    }
}

function getNetworkConnectedGraph(req, res, appData) {
    var fqName = req.query['fqName'],
        dataObjArr = [], reqUrl;

    var cFilters = [
        'UveVirtualNetworkAgent:out_bytes',
        'UveVirtualNetworkAgent:in_bytes',
        'UveVirtualNetworkAgent:out_tpkts',
        'UveVirtualNetworkAgent:out_tpkts',
        'UveVirtualNetworkAgent:in_tpkts',
        'UveVirtualNetworkAgent:in_stats',
        'UveVirtualNetworkAgent:virtualmachine_list',
        'UveVirtualNetworkAgent:interface_list',
        'UveVirtualNetworkAgent:associated_fip_count',
        'UveVirtualNetworkAgent:out_stats',
        'UveVirtualNetworkConfig'
    ];

    reqUrl = '/analytics/virtual-network/' + fqName + '?cfilt=' + cFilters.join(',');
    commonUtils.createReqObj(dataObjArr, reqUrl, global.HTTP_REQUEST_GET, null, opApiServer, null, appData);

    reqUrl = '/analytics/service-chain/*';
    commonUtils.createReqObj(dataObjArr, reqUrl, global.HTTP_REQUEST_GET, null, opApiServer, null, appData);

    reqUrl = '/virtual-networks';
    commonUtils.createReqObj(dataObjArr, reqUrl, global.HTTP_REQUEST_GET, null, configApiServer, null, appData);

    reqUrl = '/service-instances';
    commonUtils.createReqObj(dataObjArr, reqUrl, global.HTTP_REQUEST_GET, null, configApiServer, null, appData);

    async.map(dataObjArr, commonUtils.getServerResponseByRestApi(configApiServer, false), function (err, networkData) {
        networkData[0] = makeBulkDataByFqn(fqName, networkData[0]);
        processNetworkConnectedGraph(fqName, networkData, appData, function (err, result) {
            result = updateMissingVNsByConfig(fqName, result, networkData[2]);
            commonUtils.handleJSONResponse(null, res, result);
        });
    });
};

function processNetworkConnectedGraph(fqName, networkData, appData, callback) {
    var resultJSON = [], vnFound = true;

    var configVN = networkData[2]['virtual-networks'],
        configSI = networkData[3]['service-instances'];

    try {
        var vnUVE = networkData[0]['value'],
            scUVE = networkData[1]['value'];

        if ((null == vnUVE) && (null == scUVE)) {
            vnFound = false;
        }
    } catch (e) {
        vnFound = false;
    }

    if (false == vnFound) {
        callback(null, resultJSON);
        return;
    }

    parseAndGetMissingVNsUVEs(fqName, vnUVE, function (err, vnUVE) {
        var vnResultJSON = parseVirtualNetworkUVE(fqName, vnUVE),
            scResultJSON = parseServiceChainUVE(fqName, vnResultJSON, scUVE);

        scResultJSON = updateVNStatsBySIData(scResultJSON, vnUVE);
        scResultJSON['config-data'] = {'virtual-networks': configVN, 'service-instances': configSI};

        updateVNNodeStatus(scResultJSON, configVN, configSI, fqName);
        callback(null, scResultJSON);
    });
};

function getNetworkConfigGraph(req, res, appData) {
    var fqName = req.query['fqName'],
        dataObjArr = [], reqUrl;

    reqUrl = '/network-policys?parent_type=project&parent_fq_name_str=' + getProjectFQN4Network(fqName);
    commonUtils.createReqObj(dataObjArr, reqUrl, global.HTTP_REQUEST_GET, null, configApiServer, null, appData);

    async.map(dataObjArr, commonUtils.getServerResponseByRestApi(configApiServer, false), function (err, networkConfigData) {
        processNetworkConfigGraph(fqName, networkConfigData, appData, function (err, result) {
            commonUtils.handleJSONResponse(null, res, result);
        });
    });
}

function processNetworkConfigGraph(fqName, networkData, appData, callback) {
    var networkConfigGraph = {},
        configPolicy = networkData[0]['network-policys'];

    networkConfigGraph['configData'] = {"network-policys": configPolicy};
    //setAssociatedPolicys4Network(fqName, scResultJSON);

    callback(null, networkConfigGraph);

    /*
     updatePolicyConfigData(scResultJSON, appData, function (scResultJSON) {
     callback(null, scResultJSON);
     });
     updateServiceInstanceConfigData(scResultJSON, configSI, appData, function (scResultJSON) {
     callback(null, scResultJSON)
     });
     */
}

function getProjectConnectedGraph(req, res, appData) {
    var fqName = req.query['fqName'],
        dataObjArr = [], reqUrl;

    var cFilters = [
        'UveVirtualNetworkAgent:out_bytes',
        'UveVirtualNetworkAgent:in_bytes',
        'UveVirtualNetworkAgent:out_tpkts',
        'UveVirtualNetworkAgent:out_tpkts',
        'UveVirtualNetworkAgent:in_tpkts',
        'UveVirtualNetworkAgent:in_stats',
        'UveVirtualNetworkAgent:virtualmachine_list',
        'UveVirtualNetworkAgent:interface_list',
        'UveVirtualNetworkAgent:associated_fip_count',
        'UveVirtualNetworkAgent:out_stats',
        'UveVirtualNetworkConfig'
    ];

    reqUrl = '/analytics/virtual-network/' + fqName + ':*?cfilt=' + cFilters.join(',');
    commonUtils.createReqObj(dataObjArr, reqUrl, global.HTTP_REQUEST_GET, null, opApiServer, null, appData);

    reqUrl = '/analytics/service-chain/*';
    commonUtils.createReqObj(dataObjArr, reqUrl, global.HTTP_REQUEST_GET, null, opApiServer, null, appData);

    reqUrl = '/virtual-networks';
    commonUtils.createReqObj(dataObjArr, reqUrl, global.HTTP_REQUEST_GET, null, configApiServer, null, appData);

    reqUrl = '/service-instances';
    commonUtils.createReqObj(dataObjArr, reqUrl, global.HTTP_REQUEST_GET, null, configApiServer, null, appData);

    async.map(dataObjArr, commonUtils.getServerResponseByRestApi(configApiServer, false), function (err, projectData) {
        processProjectConnectedGraph(fqName, projectData, appData, function (err, result) {
            result = updateMissingVNsByConfig(fqName, result, projectData[2]);
            commonUtils.handleJSONResponse(null, res, result);
        });
    });
}

function processProjectConnectedGraph(fqName, projectData, appData, callback) {
    var resultJSON = [],
        vnFound = true;

    var configVN = projectData[2]['virtual-networks'],
        configSI = projectData[3]['service-instances'];

    try {
        var vnUVE = projectData[0]['value'];
        var scUVE = projectData[1]['value'];
        if ((null == vnUVE) && (null == scUVE)) {
            vnFound = false;
        }
    } catch (e) {
        vnFound = false;
    }
    if (false == vnFound) {
        callback(null, resultJSON);
        return;
    }

    parseAndGetMissingVNsUVEs(fqName, vnUVE, function (err, vnUVE) {
        var vnResultJSON = parseVirtualNetworkUVE(fqName, vnUVE);
        var scResultJSON = parseServiceChainUVE(fqName, vnResultJSON, scUVE);
        scResultJSON = updateVNStatsBySIData(scResultJSON, vnUVE);
        scResultJSON['config-data'] = {'virtual-networks': configVN, 'service-instances': configSI};
        updateVNNodeStatus(scResultJSON, configVN, configSI, fqName);
        callback(err, scResultJSON);
    });
}

function getProjectConfigGraph(req, res, appData) {
    var fqName = req.query['fqName'],
        dataObjArr = [], reqUrl;

    reqUrl = '/network-policys?parent_type=project&parent_fq_name_str=' + fqName;
    commonUtils.createReqObj(dataObjArr, reqUrl, global.HTTP_REQUEST_GET, null, configApiServer, null, appData);

    reqUrl = '/security-groups?parent_type=project&parent_fq_name_str=' + fqName;
    commonUtils.createReqObj(dataObjArr, reqUrl, global.HTTP_REQUEST_GET, null, configApiServer, null, appData);

    reqUrl = '/network-ipams?parent_type=project&parent_fq_name_str=' + fqName;
    commonUtils.createReqObj(dataObjArr, reqUrl, global.HTTP_REQUEST_GET, null, configApiServer, null, appData);

    async.map(dataObjArr, commonUtils.getServerResponseByRestApi(configApiServer, false), function (err, projectConfigData) {
        processProjectConfigGraph(fqName, projectConfigData, appData, function (err, result) {
            commonUtils.handleJSONResponse(null, res, result);
        });
    });
}


function processProjectConfigGraph(fqName, projectConfigData, appData, callback) {
    var configNP = projectConfigData[0]['network-policys'],
        configSG = projectConfigData[1]['security-groups'],
        configIPAM = projectConfigData[2]['network-ipams'],
        configGraphJSON = {};

    configGraphJSON['configData'] = {
        'network-policys': configNP,
        'security-groups': configSG,
        'network-ipams': configIPAM
    };

    updatePolicyConfigData(configGraphJSON, appData, function (resultJSON) {
        callback(null, resultJSON);
    });
}

exports.getNetworkConnectedGraph = getNetworkConnectedGraph;
exports.getNetworkConfigGraph = getNetworkConfigGraph;
exports.getProjectConnectedGraph = getProjectConnectedGraph;
exports.getProjectConfigGraph = getProjectConfigGraph;