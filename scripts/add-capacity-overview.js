/**
 * Script to rebuild the Cluster Capacity Overview table using a single
 * comprehensive ARG query that supports computed columns (pCPU:vCPU ratio).
 */

const fs = require('fs');
const path = require('path');

const workbookPath = path.join(__dirname, '..', 'AzureLocal-LENS-Workbook.json');
const workbook = JSON.parse(fs.readFileSync(workbookPath, 'utf8'));

const capacityGroup = workbook.items.find(i => i.name === 'capacity-tab-group');
if (!capacityGroup) { console.error('Capacity tab group not found'); process.exit(1); }

const items = capacityGroup.content.items;

// Remove the 5 items we previously inserted (if they exist)
const headerIdx = items.findIndex(i => i.name === 'text-capacity-overview-header');
if (headerIdx !== -1) {
    // Find how many of our items are there (up to the exhaustion header)
    const exhaustionIdx = items.findIndex(i => i.name === 'text-exhaustion-forecast-header');
    const count = exhaustionIdx - headerIdx;
    items.splice(headerIdx, count);
    console.log('Removed previous', count, 'items');
}

// Find insertion point (text-exhaustion-forecast-header)
const exhaustionHeaderIdx = items.findIndex(i => i.name === 'text-exhaustion-forecast-header');
if (exhaustionHeaderIdx === -1) { console.error('Exhaustion header not found'); process.exit(1); }

// Build the single comprehensive ARG query
const capacityQuery = [
    "// Cluster base data",
    "resources",
    "| where type == \"microsoft.azurestackhci/clusters\"",
    "| where '{ResourceGroupFilter}' == '' or resourceGroup matches regex strcat('(?i)', replace_string(replace_string('{ResourceGroupFilter}', '*', '.*'), '?', '.'))",
    "| where '{ClusterTagName}' == '' or ('{ClusterTagValue}' != '' and tostring(tags['{ClusterTagName}']) =~ '{ClusterTagValue}')",
    "| extend hciClusterRG = tolower(resourceGroup)",
    "| join kind=leftouter (",
    "    extensibilityresources",
    "    | where type == \"microsoft.azurestackhci/clusters/updatesummaries\"",
    "    | extend clusterName = tolower(tostring(split(id, '/')[8]))",
    "    | extend clusterRG = tolower(resourceGroup)",
    "    | extend solutionVersion = tostring(properties.currentVersion)",
    "    | project clusterName, clusterRG, solutionVersion",
    ") on $left.name == $right.clusterName, $left.hciClusterRG == $right.clusterRG",
    "| extend status = iff(properties.status == \"ConnectedRecently\", \"Connected\", \"Disconnected\")",
    "| extend nodeCount = array_length(properties.reportedProperties.nodes)",
    "| extend physicalCores = toint(properties.reportedProperties.nodes[0].coreCount) * nodeCount",
    "| extend physicalMemoryGB = toint(properties.reportedProperties.nodes[0].memoryInGiB) * nodeCount",
    "| extend osVersion = tostring(properties.reportedProperties.nodes[0].osDisplayVersion)",
    "| extend clusterLink = strcat('https://portal.azure.com/#@/resource', id)",
    "// Join VM vCPU totals per cluster RG",
    "| join kind=leftouter (",
    "    extensibilityresources",
    "    | where type == \"microsoft.azurestackhci/virtualmachineinstances\"",
    "    | extend vmId = tolower(tostring(split(id, '/providers/Microsoft.AzureStackHCI')[0]))",
    "    | join kind=inner (",
    "        resources",
    "        | where type == \"microsoft.hybridcompute/machines\"",
    "        | where kind == \"HCI\"",
    "        | project vmId = tolower(id), vmRG = tolower(resourceGroup)",
    "    ) on vmId",
    "    | extend vCPUs = toint(properties.hardwareProfile.processors)",
    "    | extend memMB = toint(properties.hardwareProfile.memoryMB)",
    "    | summarize vmVCPUTotal = sum(vCPUs), vmMemoryTotalMB = sum(memMB) by vmRG",
    ") on $left.hciClusterRG == $right.vmRG",
    "// Join AKS Arc vCPU totals per cluster RG",
    "| join kind=leftouter (",
    "    extensibilityresources",
    "    | where type == \"microsoft.hybridcontainerservice/provisionedclusterinstances\"",
    "    | extend customLocId = tolower(tostring(extendedLocation.name))",
    "    | mv-expand pool = properties.agentPoolProfiles",
    "    | extend poolVCPUs = toint(pool['count'])",
    "    | join kind=inner (",
    "        resources",
    "        | where type == \"microsoft.extendedlocation/customlocations\"",
    "        | extend customLocId = tolower(id)",
    "        | extend aksRG = tolower(tostring(split(tostring(properties.hostResourceId), '/')[4]))",
    "        | project customLocId, aksRG",
    "    ) on customLocId",
    "    | summarize aksVCPUTotal = sum(poolVCPUs) by aksRG",
    ") on $left.hciClusterRG == $right.aksRG",
    "// Compute totals and ratio",
    "| extend vmVCPUTotal = coalesce(vmVCPUTotal, 0)",
    "| extend vmMemoryTotalMB = coalesce(vmMemoryTotalMB, 0)",
    "| extend aksVCPUTotal = coalesce(aksVCPUTotal, 0)",
    "| extend vCPUTotal = vmVCPUTotal + aksVCPUTotal",
    "| extend vmMemoryTotalGB = round(todouble(vmMemoryTotalMB) / 1024.0, 1)",
    "| extend pCPUvCPURatio = iff(physicalCores > 0 and vCPUTotal > 0, strcat('1:', tostring(round(todouble(vCPUTotal) / todouble(physicalCores), 1))), 'N/A')",
    "| project ClusterName = name, clusterLink, resourceGroup, status, solutionVersion, nodeCount, physicalCores, physicalMemoryGB, osVersion, vmVCPUTotal, aksVCPUTotal, vCPUTotal, vmMemoryTotalGB, pCPUvCPURatio",
    "| order by status asc, ClusterName asc"
].join("\r\n");

const sectionHeader = {
    type: 1,
    content: {
        json: "## 📊 Cluster Capacity Overview\r\nPhysical cores, virtual CPU allocation, and pCPU:vCPU ratio per Azure Local cluster."
    },
    name: "text-capacity-overview-header"
};

const capacityTable = {
    type: 3,
    content: {
        version: "KqlItem/1.0",
        query: capacityQuery,
        size: 0,
        showAnalytics: true,
        title: "Cluster Capacity Overview",
        showRefreshButton: true,
        showExportToExcel: true,
        queryType: 1,
        resourceType: "microsoft.resourcegraph/resources",
        crossComponentResources: ["{Subscriptions}"],
        visualization: "table",
        gridSettings: {
            formatters: [
                {
                    columnMatch: "ClusterName",
                    formatter: 7,
                    formatOptions: {
                        linkTarget: "Url",
                        linkColumn: "clusterLink"
                    }
                },
                {
                    columnMatch: "clusterLink",
                    formatter: 5
                },
                {
                    columnMatch: "status",
                    formatter: 18,
                    formatOptions: {
                        thresholdsOptions: "icons",
                        thresholdsGrid: [
                            {
                                operator: "==",
                                thresholdValue: "Connected",
                                representation: "success",
                                text: "{0}{1}"
                            },
                            {
                                operator: "Default",
                                thresholdValue: null,
                                representation: "4",
                                text: "{0}{1}"
                            }
                        ]
                    }
                },
                {
                    columnMatch: "physicalCores",
                    formatter: 0,
                    numberFormat: {
                        unit: 0,
                        options: { style: "decimal", minimumFractionDigits: 0, maximumFractionDigits: 0 }
                    }
                },
                {
                    columnMatch: "physicalMemoryGB",
                    formatter: 0,
                    numberFormat: {
                        unit: 5,
                        options: { style: "decimal", minimumFractionDigits: 0, maximumFractionDigits: 0 }
                    }
                },
                {
                    columnMatch: "vmVCPUTotal",
                    formatter: 0,
                    numberFormat: {
                        unit: 0,
                        options: { style: "decimal", minimumFractionDigits: 0, maximumFractionDigits: 0 }
                    }
                },
                {
                    columnMatch: "aksVCPUTotal",
                    formatter: 0,
                    numberFormat: {
                        unit: 0,
                        options: { style: "decimal", minimumFractionDigits: 0, maximumFractionDigits: 0 }
                    }
                },
                {
                    columnMatch: "vCPUTotal",
                    formatter: 8,
                    formatOptions: {
                        min: 0,
                        palette: "blue"
                    },
                    numberFormat: {
                        unit: 0,
                        options: { style: "decimal", minimumFractionDigits: 0, maximumFractionDigits: 0 }
                    }
                },
                {
                    columnMatch: "vmMemoryTotalGB",
                    formatter: 0,
                    numberFormat: {
                        unit: 5,
                        options: { style: "decimal", minimumFractionDigits: 1, maximumFractionDigits: 1 }
                    }
                },
                {
                    columnMatch: "pCPUvCPURatio",
                    formatter: 1,
                    formatOptions: {
                        customColumnWidthSetting: "120px"
                    }
                }
            ],
            filter: true,
            labelSettings: [
                { columnId: "ClusterName", label: "Cluster Name" },
                { columnId: "clusterLink" },
                { columnId: "resourceGroup", label: "Resource Group" },
                { columnId: "status", label: "Status" },
                { columnId: "solutionVersion", label: "Solution Version" },
                { columnId: "nodeCount", label: "Nodes" },
                { columnId: "physicalCores", label: "Physical Cores" },
                { columnId: "physicalMemoryGB", label: "Physical Memory (GB)" },
                { columnId: "osVersion", label: "OS Version" },
                { columnId: "vmVCPUTotal", label: "VM vCPUs" },
                { columnId: "aksVCPUTotal", label: "AKS vCPUs" },
                { columnId: "vCPUTotal", label: "vCPU Total" },
                { columnId: "vmMemoryTotalGB", label: "VM Memory Total (GB)" },
                { columnId: "pCPUvCPURatio", label: "pCPU:vCPU Ratio" }
            ]
        }
    },
    name: "capacity-overview-table"
};

// Insert the 2 items before "text-exhaustion-forecast-header"
items.splice(exhaustionHeaderIdx, 0, sectionHeader, capacityTable);

// Write out
fs.writeFileSync(workbookPath, JSON.stringify(workbook, null, 2) + '\n', 'utf8');
console.log('Successfully added Cluster Capacity Overview with single ARG query');
console.log('Total items in Capacity tab:', items.length);
