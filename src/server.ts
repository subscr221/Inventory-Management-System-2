import { createServer, type Server } from 'node:http';
import { pathToFileURL } from 'node:url';
import { config } from './config/index.js';
import { Router } from './api/router.js';
import { healthHandler } from './api/v1/health.js';
import { postEventHandler, getStreamHandler } from './api/v1/events.js';
import { provisionUserHandler, patchUserHandler } from './api/v1/scim.js';
import { devTokenHandler } from './api/v1/auth-dev.js';
import { auditLogHandler } from './api/v1/audit.js';
import { configAuditLogHandler } from './api/v1/config.js';
import {
  createDoaEntryHandler,
  updateDoaEntryHandler,
  createDelegationHandler,
  resolveDoaHandler,
  workflowConfigHandler,
} from './api/v1/doa.js';
import {
  createTaggingRuleHandler,
  getTaggingRuleHandler,
  listBusinessStreamsHandler,
} from './api/v1/business-stream.js';
import { getCurrentLocationHandler, seedExpectedLocationHandler } from './api/v1/location.js';
import { createItemHandler, updateItemHandler, getItemHandler } from './api/v1/items.js';
import { getStockHandler } from './api/v1/stock.js';
import {
  getValuationHandler,
  nrvWriteDownHandler,
  nrvRecoveryHandler,
  standardCostVarianceReviewHandler,
  standardCostVarianceReportHandler,
} from './api/v1/valuation.js';
import {
  createLocationHandler,
  updateLocationHandler,
  listLocationsHandler,
  getLocationHandler,
} from './api/v1/location-register.js';
import {
  updateCalibrationStatusHandler,
  createQcResultHandler,
  createCalibrationEscalationHandler,
} from './api/v1/instruments.js';
import {
  edgeBootstrapHandler,
  powerSyncCredentialsHandler,
  edgeEventUploadHandler,
} from './api/v1/edge.js';
import {
  listNotificationsHandler,
  getUnreadCountHandler,
  updateNotificationHandler,
  acknowledgeNotificationHandler,
  getPreferencesHandler,
  putPreferencesHandler,
  createPushSubscriptionHandler,
  deletePushSubscriptionHandler,
} from './api/v1/notification.js';
import {
  getLotTraceHandler,
  selectLotHandler,
  placeQualityHoldHandler,
  clearQualityHoldHandler,
} from './api/v1/lots.js';
import {
  createCycleCountHandler,
  submitCycleCountHandler,
  approveAdjustmentHandler,
  rejectAdjustmentHandler,
  getCycleCountHandler,
  listCycleCountsHandler,
} from './api/v1/cycle-counts.js';
import {
  completePhysicalVerificationHandler,
  signOffPhysicalVerificationHandler,
  physicalVerificationReportHandler,
} from './api/v1/physical-verification.js';
import {
  setPlanningParamsHandler,
  getPlanningParamsHandler,
  computeSafetyStockHandler,
  checkReplenishmentHandler,
  listRecommendationsHandler,
  scanObsolescenceHandler,
  obsolescenceReportHandler,
  checkVmiReplenishmentHandler,
} from './api/v1/inventory-planning.js';
import {
  putOwnershipAgreementHandler,
  listOwnershipAgreementsHandler,
} from './api/v1/ownership-agreements.js';
import {
  getPurchaseOrderHandler,
  listSalesOrdersHandler,
  erpSyncTriggerHandler,
  erpReadOnlyRejectHandler,
  listBomSyncExceptionsHandler,
  resolveBomSyncExceptionHandler,
} from './api/v1/erp-projections.js';
import {
  createGateEventHandler,
  reverseGateEventHandler,
  getGateEventHandler,
  listGateEventsHandler,
} from './api/v1/gate.js';
import {
  createWeighbridgeEventHandler,
  getWeighbridgeEventHandler,
  listWeighbridgeEventsHandler,
} from './api/v1/weighbridge.js';
import { createAsnHandler, getAsnHandler } from './api/v1/asn.js';
import {
  createGrnLineHandler,
  getGrnHandler,
  listGrnsHandler,
  listDiscrepanciesHandler,
  releasePutawayTaskHandler,
} from './api/v1/receiving.js';
import {
  handleListPutawayTasks,
  handleGetPutawayTask,
  handleGetPutawaySuggestion,
  handleCompletePutaway,
  handleAssignPutawayTask,
  handleListVelocityClassification,
  handleReslottingJob,
} from './api/v1/putaway.js';
import {
  handleListWarehouseTasks,
  handleGetProductivity,
  handleGetGateDwellExceptions,
  handleGetSlaConfig,
  handlePutSlaConfig,
} from './api/v1/warehouse-tasks.js';
import {
  handleGetForwardPickConfig,
  handlePutForwardPickConfig,
  handleCheckReplenishment,
  handleConfirmReplenishmentTask,
  handleAssignReplenishmentTask,
} from './api/v1/replenishment.js';
import {
  handleGetCrossDockTask,
  handleAssignCrossDockTask,
  handleConfirmCrossDockTask,
} from './api/v1/cross-dock.js';
import {
  createSupplierHandler,
  getSupplierHandler,
  listSuppliersHandler,
  submitOnboardingHandler,
  approveOnboardingHandler,
  rejectOnboardingHandler,
  updateSupplierHandler,
  deactivateSupplierHandler,
  verifySupplierMsmeHandler,
} from './api/v1/suppliers.js';
import {
  raiseIndentHandler,
  getIndentHandler,
  listIndentsHandler,
  confirmIndentHandler,
  withdrawIndentHandler,
  approveIndentHandler,
  rejectIndentHandler,
  cancelIndentHandler,
} from './api/v1/indents.js';
import {
  draftPurchaseOrderHandler,
  getNativePurchaseOrderHandler,
  listPurchaseOrdersHandler,
  approvePurchaseOrderHandler,
  rejectPurchaseOrderHandler,
  issuePurchaseOrderHandler,
  confirmPurchaseOrderHandler,
  recordReleaseHandler,
  reviseCeilingHandler,
} from './api/v1/purchase-orders.js';
import {
  draftBomHandler,
  addBomLineHandler,
  amendBomLineHandler,
  getBomHandler,
  listBomsHandler,
  getBomStructureHandler,
  releaseBomHandler,
  holdBomHandler,
  obsoleteBomHandler,
  getReleaseGateHandler,
  migrateLegacyKitsHandler,
  listMigrationExceptionsHandler,
} from './api/v1/boms.js';
import {
  raiseEcoHandler,
  listEcosHandler,
  getEcoHandler,
  getEcoImpactHandler,
  startEcoReviewHandler,
  approveEcoHandler,
  recordEcoDispositionsHandler,
  implementEcoHandler,
  cancelEcoHandler,
} from './api/v1/ecos.js';
import {
  cloneToRdHandler,
  recordBuildHandler,
  listBuildsHandler,
  getBuildHandler,
  confirmBuildHandler,
  signProductizationHandler,
  getProductizationGateHandler,
  productizeHandler,
} from './api/v1/rd-boms.js';
import {
  defineAlternateHandler,
  listBomAlternatesHandler,
  approveSubstitutionHandler,
  explodeBomHandler,
  getExplosionHandler,
} from './api/v1/bom-execution.js';
import {
  runCostRollupHandler,
  listCostRollupsHandler,
  compareCostRollupsHandler,
  getCostRollupHandler,
  tagJobWorkKitHandler,
} from './api/v1/bom-costing.js';
import { createAssetHandler, getAssetHandler, listAssetsHandler } from './api/v1/assets.js';
import {
  acceptFaultReportHandler,
  closeDowntimeHandler,
  completeWorkOrderHandler,
  createFaultReportHandler,
  createMeterHandler,
  createPlanHandler,
  createSlaPolicyHandler,
  generateReliabilityReportHandler,
  generateWorkOrdersHandler,
  getFaultReportHandler,
  getPlanHandler,
  getWorkOrderHandler,
  listFaultReportsHandler,
  listMeterReadingsHandler,
  listMetersHandler,
  listPlansHandler,
  listReliabilityMetricsHandler,
  listSlaPoliciesHandler,
  listWorkOrdersHandler,
  recordMeterReadingHandler,
  reconcileMetersHandler,
  rejectFaultReportHandler,
  sweepGraceWindowsHandler,
  addAssetPartHandler,
  cancelSpareReservationHandler,
  createSpareHandler,
  issueSpareHandler,
  listAssetPartsHandler,
  listSpareAlertsHandler,
  listSpareReservationsHandler,
  listSparesHandler,
  reserveSpareHandler,
  returnSpareHandler,
  scanSparesHandler,
  whereUsedHandler,
  createInstrumentHandler,
  listInstrumentsHandler,
  getInstrumentHandler,
  recordCertificateHandler,
  listCertificatesHandler,
  raiseCalibrationEscalationHandler,
  scanCalibrationHandler,
  listCalibrationAlertsHandler,
  listCalibrationEscalationsHandler,
  resolveCalibrationEscalationHandler,
  createStatutoryExaminationHandler,
  listStatutoryExaminationsHandler,
  getStatutoryExaminationHandler,
  scanStatutoryExaminationsHandler,
  setAssetStatusHandler,
  getAssetStatusHandler,
  listAssetStatusesHandler,
  getAssetCostsHandler,
  listAssetCostsHandler,
  recordCoverageHandler,
  listAssetCoveragesHandler,
  listCoveragesHandler,
  listCoverageAlertsHandler,
  scanCoveragesHandler,
  getCoverageHandler,
  recordWarrantyOverrideHandler,
  getWarrantyOverrideHandler,
} from './api/v1/maintenance.js';
import {
  createProductionOrderHandler,
  listProductionOrdersHandler,
  getProductionOrderHandler,
  getProductionReleaseGateHandler,
  releaseProductionOrderHandler,
  transitionProductionOrderHandler,
  cancelProductionOrderHandler,
} from './api/v1/production-orders.js';
import {
  stageMaterialHandler,
  listStagingHandler,
  issueMaterialHandler,
  recordConfirmationHandler,
  returnMaterialHandler,
  getWipHandler,
} from './api/v1/production-material.js';
import {
  captureSupplierInvoiceHandler,
  captureDuplicateOverrideHandler,
  getSupplierInvoiceHandler,
  listSupplierInvoicesHandler,
  linkSupplierInvoiceToPoHandler,
  stageInvoiceIngestionHandler,
  getInvoiceIngestionHandler,
  listInvoiceIngestionsHandler,
  confirmInvoiceIngestionHandler,
} from './api/v1/supplier-invoices.js';
import {
  msmeAgeingReportHandler,
  runMsmeAgeingFeedHandler,
  runMsmeDailyCheckHandler,
} from './api/v1/msme.js';
import {
  linkGrnToPoHandler,
  runThreeWayMatchHandler,
  listThreeWayMatchesHandler,
  getThreeWayMatchHandler,
  recordCreditNoteHandler,
  recordDebitNoteHandler,
  runPaymentClearanceFeedHandler,
  listClearanceEligibleHandler,
} from './api/v1/three-way-match.js';
import {
  getSupplierScorecardHandler,
  listSupplierScorecardTransactionsHandler,
  recordOnTimeDeliveryMetricHandler,
  recordPriceVarianceMetricHandler,
  recordResponsivenessMetricHandler,
} from './api/v1/supplier-scorecards.js';
import {
  generatePickTasksHandler,
  generateWavePickTasksHandler,
  generateBatchPickTasksHandler,
  listPickTasksHandler,
  getPickTaskHandler,
  assignPickTaskHandler,
  confirmPickLineHandler,
  completePickTaskHandler,
  printPickTaskHandler,
} from './api/v1/pick-tasks.js';
import {
  postPacked,
  postShippingDocumentsGenerated,
  postDispatched,
  getPackingRecords,
  getDispatchDocuments,
  getPackingRecord,
  getDispatchOrderStatusHandler,
  getDispatchDocument,
} from './api/v1/dispatch.js';
import {
  createTransferRequestHandler,
  getTransferRequestHandler,
  listTransferRequestsHandler,
  approveTransferRequestHandler,
  rejectTransferRequestHandler,
  shipTransferRequestHandler,
  receiveTransferRequestHandler,
  getInTransitHandler,
} from './api/v1/transfer-requests.js';
import { runDispatchCycle } from './notify/dispatch.js';
import { runEscalationCycle } from './notify/escalate.js';
import { runExpiryCycle } from './notify/expire.js';

export function createAppRouter(): Router {
  const router = new Router();

  router.get('/api/v1/health', healthHandler);
  router.post('/api/v1/events', postEventHandler);
  router.get('/api/v1/events/:streamType/:streamId', getStreamHandler);
  router.post('/api/v1/scim/v2/Users', provisionUserHandler);
  router.patch('/api/v1/scim/v2/Users/:externalId', patchUserHandler);
  router.get('/api/v1/audit/log', auditLogHandler);
  router.put('/api/v1/config/audit-log-enabled', configAuditLogHandler);
  router.post('/api/v1/doa/entries', createDoaEntryHandler);
  router.patch('/api/v1/doa/entries/:entryId', updateDoaEntryHandler);
  router.post('/api/v1/doa/delegations', createDelegationHandler);
  router.post('/api/v1/doa/resolve', resolveDoaHandler);
  router.post('/api/v1/doa/workflow-config', workflowConfigHandler);
  router.post('/api/v1/business-streams/rules', createTaggingRuleHandler);
  router.get('/api/v1/business-streams/rules', getTaggingRuleHandler);
  router.get('/api/v1/business-streams', listBusinessStreamsHandler);
  // Story 2.1: /api/v1/locations/* now belongs to the location register (warehouse topology
  // master). The Story 1.6 current-lot-location API moved to explicit /api/v1/lots/* routes -
  // keeping both under /locations would be ambiguous (router matching ignores parameter names).
  router.get('/api/v1/lots/:lotId/location', getCurrentLocationHandler);
  router.post('/api/v1/lots/:lotId/location/expected', seedExpectedLocationHandler);
  router.post('/api/v1/items', createItemHandler);
  router.patch('/api/v1/items/:sku', updateItemHandler);
  router.get('/api/v1/items/:sku', getItemHandler);
  router.post('/api/v1/locations', createLocationHandler);
  router.get('/api/v1/locations', listLocationsHandler);
  router.patch('/api/v1/locations/:locationId', updateLocationHandler);
  router.get('/api/v1/locations/:locationId', getLocationHandler);
  router.get('/api/v1/stock/:sku', getStockHandler);
  router.get('/api/v1/stock/:sku/valuation', getValuationHandler);
  router.post('/api/v1/stock/:sku/valuation/nrv-write-down', nrvWriteDownHandler);
  router.post('/api/v1/stock/:sku/valuation/nrv-recovery', nrvRecoveryHandler);
  router.post(
    '/api/v1/stock/:sku/valuation/standard-cost-variance-review',
    standardCostVarianceReviewHandler,
  );
  router.get('/api/v1/valuation/standard-cost-variance-report', standardCostVarianceReportHandler);
  // Story 2.5: Inter-Location Transfer Requests
  router.post('/api/v1/transfer-requests', createTransferRequestHandler);
  router.get('/api/v1/transfer-requests/:transfer_request_id', getTransferRequestHandler);
  router.get('/api/v1/transfer-requests', listTransferRequestsHandler);
  router.patch(
    '/api/v1/transfer-requests/:transfer_request_id/approve',
    approveTransferRequestHandler,
  );
  router.patch(
    '/api/v1/transfer-requests/:transfer_request_id/reject',
    rejectTransferRequestHandler,
  );
  router.post('/api/v1/transfer-requests/:transfer_request_id/ship', shipTransferRequestHandler);
  router.post(
    '/api/v1/transfer-requests/:transfer_request_id/receive',
    receiveTransferRequestHandler,
  );
  router.get('/api/v1/stock/:sku/in-transit', getInTransitHandler);
  // Story 2.6: Cycle Counting and Physical Inventory
  router.post('/api/v1/cycle-counts', createCycleCountHandler);
  router.get('/api/v1/cycle-counts', listCycleCountsHandler);
  router.get('/api/v1/cycle-counts/:cycle_count_id', getCycleCountHandler);
  router.post('/api/v1/cycle-counts/:cycle_count_id/submit', submitCycleCountHandler);
  router.patch(
    '/api/v1/cycle-counts/:cycle_count_id/adjustments/:adjustment_id/approve',
    approveAdjustmentHandler,
  );
  router.patch(
    '/api/v1/cycle-counts/:cycle_count_id/adjustments/:adjustment_id/reject',
    rejectAdjustmentHandler,
  );
  router.post('/api/v1/physical-verifications', completePhysicalVerificationHandler);
  router.post(
    '/api/v1/physical-verifications/:physical_verification_id/sign-off',
    signOffPhysicalVerificationHandler,
  );
  router.get('/api/v1/physical-verification/report', physicalVerificationReportHandler);
  // Story 2.7: Safety Stock, Reorder Points, and Obsolescence Flagging
  router.post('/api/v1/planning/params', setPlanningParamsHandler);
  router.get('/api/v1/planning/params/:sku', getPlanningParamsHandler);
  router.post('/api/v1/planning/safety-stock/compute', computeSafetyStockHandler);
  router.post('/api/v1/planning/replenishment/check', checkReplenishmentHandler);
  router.get('/api/v1/planning/replenishment/recommendations', listRecommendationsHandler);
  router.post('/api/v1/planning/obsolescence/scan', scanObsolescenceHandler);
  router.get('/api/v1/planning/obsolescence/report', obsolescenceReportHandler);
  // Story 2.8: Consignment and VMI Stock Segregation
  router.get('/api/v1/ownership-agreements', listOwnershipAgreementsHandler);
  router.put(
    '/api/v1/ownership-agreements/:sku/:locationId/:stockClass',
    putOwnershipAgreementHandler,
  );
  router.post('/api/v1/planning/vmi/check', checkVmiReplenishmentHandler);
  // Story 2.9: ERP Inbound Reference Projections (read-only; INT-ERP-01). Every write verb is
  // registered to an explicit reject handler returning SOURCE_SYSTEM_READ_ONLY (the router 404s
  // unregistered methods, so a bare 404 would otherwise mask the stable read-only code).
  router.get('/api/v1/erp/purchase-orders/:poNumber', getPurchaseOrderHandler);
  router.get('/api/v1/erp/sales-orders', listSalesOrdersHandler);
  router.post('/api/v1/erp/sync', erpSyncTriggerHandler);
  router.post('/api/v1/erp/purchase-orders', erpReadOnlyRejectHandler);
  router.put('/api/v1/erp/purchase-orders', erpReadOnlyRejectHandler);
  router.patch('/api/v1/erp/purchase-orders', erpReadOnlyRejectHandler);
  router.delete('/api/v1/erp/purchase-orders', erpReadOnlyRejectHandler);
  router.post('/api/v1/erp/purchase-orders/:poNumber', erpReadOnlyRejectHandler);
  router.put('/api/v1/erp/purchase-orders/:poNumber', erpReadOnlyRejectHandler);
  router.patch('/api/v1/erp/purchase-orders/:poNumber', erpReadOnlyRejectHandler);
  router.delete('/api/v1/erp/purchase-orders/:poNumber', erpReadOnlyRejectHandler);
  router.post('/api/v1/erp/sales-orders', erpReadOnlyRejectHandler);
  router.put('/api/v1/erp/sales-orders', erpReadOnlyRejectHandler);
  router.patch('/api/v1/erp/sales-orders', erpReadOnlyRejectHandler);
  router.delete('/api/v1/erp/sales-orders', erpReadOnlyRejectHandler);
  // Story 3.2: Gate Event Capture and Vehicle-to-PO Binding
  router.post('/api/v1/gate-events', createGateEventHandler);
  router.post('/api/v1/gate-events/:gateEventId/reverse', reverseGateEventHandler);
  router.get('/api/v1/gate-events/:gateEventId', getGateEventHandler);
  router.get('/api/v1/gate-events', listGateEventsHandler);

  // Story 3.3: Weighbridge Event Capture and Tolerance Enforcement
  router.post('/api/v1/weighbridge-events', createWeighbridgeEventHandler);
  router.get('/api/v1/weighbridge-events/:weighbridgeEventId', getWeighbridgeEventHandler);
  router.get('/api/v1/weighbridge-events', listWeighbridgeEventsHandler);

  // Story 3.4: Goods Receiving Against ASN or PO
  router.post('/api/v1/asn', createAsnHandler);
  router.get('/api/v1/asn/:asnNumberExt', getAsnHandler);
  router.post('/api/v1/grn-lines', createGrnLineHandler);
  router.get('/api/v1/grns/:grnId', getGrnHandler);
  router.get('/api/v1/grns', listGrnsHandler);
  router.get('/api/v1/receiving/discrepancies', listDiscrepanciesHandler);
  router.post('/api/v1/putaway-tasks/:putawayTaskId/release', releasePutawayTaskHandler);

  // Story 3.5: Directed Putaway and Location Override
  router.get('/api/v1/putaway-tasks', handleListPutawayTasks);
  router.get('/api/v1/putaway-tasks/:putawayTaskId', handleGetPutawayTask);
  router.get('/api/v1/putaway-tasks/:putawayTaskId/suggestion', handleGetPutawaySuggestion);
  router.post('/api/v1/putaway-tasks/:putawayTaskId/complete', handleCompletePutaway);
  router.get('/api/v1/velocity-classification', handleListVelocityClassification);
  router.post('/api/v1/velocity-classification/reslot', handleReslottingJob);

  // Story 3.8: Warehouse Task Management and Productivity Tracking
  router.post('/api/v1/putaway-tasks/:putawayTaskId/assign', handleAssignPutawayTask);
  router.get('/api/v1/warehouse-tasks', handleListWarehouseTasks);
  router.get('/api/v1/warehouse-tasks/productivity', handleGetProductivity);
  router.get('/api/v1/warehouse-tasks/exceptions/gate-dwell', handleGetGateDwellExceptions);
  router.get('/api/v1/warehouse-tasks/sla-config', handleGetSlaConfig);
  router.put('/api/v1/warehouse-tasks/sla-config', handlePutSlaConfig);

  // Story 3.9: Forward-Pick Replenishment
  router.get('/api/v1/replenishment/config', handleGetForwardPickConfig);
  router.put('/api/v1/replenishment/config', handlePutForwardPickConfig);
  router.post('/api/v1/replenishment/check', handleCheckReplenishment);
  router.post(
    '/api/v1/replenishment-tasks/:replenishmentTaskId/confirm',
    handleConfirmReplenishmentTask,
  );
  router.post(
    '/api/v1/replenishment-tasks/:replenishmentTaskId/assign',
    handleAssignReplenishmentTask,
  );

  router.get('/api/v1/cross-dock-tasks/:crossDockTaskId', handleGetCrossDockTask);
  router.post('/api/v1/cross-dock-tasks/:crossDockTaskId/assign', handleAssignCrossDockTask);
  router.post('/api/v1/cross-dock-tasks/:crossDockTaskId/confirm', handleConfirmCrossDockTask);

  // Story 4.1: Supplier Registry and Onboarding
  router.post('/api/v1/suppliers', createSupplierHandler);
  router.get('/api/v1/suppliers/:supplierId', getSupplierHandler);
  router.get('/api/v1/suppliers', listSuppliersHandler);
  router.post('/api/v1/suppliers/:supplierId/onboarding/submit', submitOnboardingHandler);
  router.post('/api/v1/suppliers/:supplierId/onboarding/approve', approveOnboardingHandler);
  router.post('/api/v1/suppliers/:supplierId/onboarding/reject', rejectOnboardingHandler);
  router.patch('/api/v1/suppliers/:supplierId', updateSupplierHandler);
  router.post('/api/v1/suppliers/:supplierId/deactivate', deactivateSupplierHandler);
  // Story 4.6: MSME Compliance Tracking - Udyam verification / re-verification
  router.post('/api/v1/suppliers/:supplierId/msme', verifySupplierMsmeHandler);

  // Story 4.3: Purchase Requisition and Indent Loop
  router.post('/api/v1/indents', raiseIndentHandler);
  router.get('/api/v1/indents/:indentId', getIndentHandler);
  router.get('/api/v1/indents', listIndentsHandler);
  router.post('/api/v1/indents/:indentId/confirm', confirmIndentHandler);
  router.post('/api/v1/indents/:indentId/withdraw', withdrawIndentHandler);
  router.post('/api/v1/indents/:indentId/approve', approveIndentHandler);
  router.post('/api/v1/indents/:indentId/reject', rejectIndentHandler);
  router.post('/api/v1/indents/:indentId/cancel', cancelIndentHandler);

  // Story 4.4: Purchase Order Management
  router.post('/api/v1/purchase-orders', draftPurchaseOrderHandler);
  router.get('/api/v1/purchase-orders/:poId', getNativePurchaseOrderHandler);
  router.get('/api/v1/purchase-orders', listPurchaseOrdersHandler);
  router.post('/api/v1/purchase-orders/:poId/approve', approvePurchaseOrderHandler);
  router.post('/api/v1/purchase-orders/:poId/reject', rejectPurchaseOrderHandler);
  router.post('/api/v1/purchase-orders/:poId/issue', issuePurchaseOrderHandler);
  router.post('/api/v1/purchase-orders/:poId/confirm', confirmPurchaseOrderHandler);
  router.post('/api/v1/purchase-orders/:poId/releases', recordReleaseHandler);
  router.post('/api/v1/purchase-orders/:poId/ceiling', reviseCeilingHandler);

  // Story 5.1: BOM Management
  router.post('/api/v1/boms', draftBomHandler);
  router.get('/api/v1/boms', listBomsHandler);
  // Story 5.2: registered ABOVE GET /api/v1/boms/:bomId - the router returns the first match in
  // registration order and :bomId would swallow the literal 'migration-exceptions'.
  router.get('/api/v1/boms/migration-exceptions', listMigrationExceptionsHandler);
  router.get('/api/v1/boms/:bomId', getBomHandler);
  router.get('/api/v1/boms/:bomId/structure', getBomStructureHandler);
  router.post('/api/v1/boms/:bomId/lines', addBomLineHandler);
  router.patch('/api/v1/boms/:bomId/lines/:bomLineId', amendBomLineHandler);

  // Story 5.2: BOM Lifecycle
  router.post('/api/v1/boms/:bomId/release', releaseBomHandler);
  router.post('/api/v1/boms/:bomId/hold', holdBomHandler);
  router.post('/api/v1/boms/:bomId/obsolete', obsoleteBomHandler);
  router.get('/api/v1/boms/:bomId/release-gate', getReleaseGateHandler);
  router.post('/api/v1/boms/legacy-kit-migration', migrateLegacyKitsHandler);

  // Story 5.3: ECO Workflow and Where-Used Impact
  router.post('/api/v1/ecos', raiseEcoHandler);
  router.get('/api/v1/ecos', listEcosHandler);
  router.get('/api/v1/ecos/:ecoId', getEcoHandler);
  router.get('/api/v1/ecos/:ecoId/impact', getEcoImpactHandler);
  router.post('/api/v1/ecos/:ecoId/review', startEcoReviewHandler);
  router.post('/api/v1/ecos/:ecoId/approve', approveEcoHandler);
  router.post('/api/v1/ecos/:ecoId/dispositions', recordEcoDispositionsHandler);
  router.post('/api/v1/ecos/:ecoId/implement', implementEcoHandler);
  router.post('/api/v1/ecos/:ecoId/cancel', cancelEcoHandler);

  // Story 5.4: R&D Draft BOM Regime
  router.post('/api/v1/boms/:bomId/clone-to-rd', cloneToRdHandler);
  router.post('/api/v1/boms/:bomId/builds', recordBuildHandler);
  router.get('/api/v1/boms/:bomId/builds', listBuildsHandler);
  router.get('/api/v1/rd-builds/:buildId', getBuildHandler);
  router.post('/api/v1/rd-builds/:buildId/confirm', confirmBuildHandler);
  router.post('/api/v1/boms/:bomId/productization-signoffs', signProductizationHandler);
  router.get('/api/v1/boms/:bomId/productization-gate', getProductizationGateHandler);
  router.post('/api/v1/boms/:bomId/productize', productizeHandler);

  // Story 5.5: Approved Alternates and BOM Explosion. Every second segment is a literal distinct
  // from the :bomId-only routes above, so there is no route-order trap here.
  router.post('/api/v1/boms/:bomId/alternates', defineAlternateHandler);
  router.get('/api/v1/boms/:bomId/alternates', listBomAlternatesHandler);
  router.post('/api/v1/boms/:bomId/substitution-approvals', approveSubstitutionHandler);
  router.post('/api/v1/boms/:bomId/explosion', explodeBomHandler);
  router.get('/api/v1/bom-explosions/:explosionId', getExplosionHandler);

  // Story 5.6: Cost Rollups, Job-Work Kit Tagging, and ERP Outbound Sync.
  router.post('/api/v1/boms/:bomId/cost-rollups', runCostRollupHandler);
  router.get('/api/v1/boms/:bomId/cost-rollups', listCostRollupsHandler);
  // Registered ABOVE GET /api/v1/bom-cost-rollups/:rollupId - the router returns the first match
  // in registration order and :rollupId compiles to ([^/]+), which would swallow 'compare'.
  router.get('/api/v1/bom-cost-rollups/compare', compareCostRollupsHandler);
  router.get('/api/v1/bom-cost-rollups/:rollupId', getCostRollupHandler);
  router.post('/api/v1/boms/:bomId/job-work-kit-tags', tagJobWorkKitHandler);
  router.get('/api/v1/erp/bom-sync-exceptions', listBomSyncExceptionsHandler);
  router.post(
    '/api/v1/erp/bom-sync-exceptions/:exceptionId/resolve',
    resolveBomSyncExceptionHandler,
  );

  // Story 7.1: Asset Register and Criticality Classification (maintenance stream, AD-9).
  // GET /api/v1/assets registered before GET /api/v1/assets/:assetId - the router returns the
  // first match in registration order and :assetId compiles to ([^/]+).
  router.post('/api/v1/assets', createAssetHandler);
  router.get('/api/v1/assets', listAssetsHandler);
  router.get('/api/v1/assets/:assetId', getAssetHandler);

  // Story 7.2: PM plans, work orders and the meter-reading ingestion API (FR-M-02, FR-M-03).
  // Static segments register BEFORE their parameterized siblings - the router returns the first
  // match in registration order and :id compiles to ([^/]+) - so /meters/reconcile precedes
  // /meters/:meterId/readings and every list route precedes its :id route.
  router.post('/api/v1/maintenance/plans', createPlanHandler);
  router.get('/api/v1/maintenance/plans', listPlansHandler);
  router.get('/api/v1/maintenance/plans/:planId', getPlanHandler);
  router.post('/api/v1/maintenance/meters', createMeterHandler);
  router.get('/api/v1/maintenance/meters', listMetersHandler);
  router.post('/api/v1/maintenance/meters/reconcile', reconcileMetersHandler);
  router.get('/api/v1/maintenance/meters/:meterId/readings', listMeterReadingsHandler);
  router.post('/api/v1/maintenance/meter-readings', recordMeterReadingHandler);
  router.post('/api/v1/maintenance/pm/generate', generateWorkOrdersHandler);
  router.post('/api/v1/maintenance/pm/grace-sweep', sweepGraceWindowsHandler);
  router.get('/api/v1/maintenance/work-orders', listWorkOrdersHandler);
  router.get('/api/v1/maintenance/work-orders/:workOrderId', getWorkOrderHandler);
  router.post('/api/v1/maintenance/work-orders/:workOrderId/complete', completeWorkOrderHandler);

  // Story 7.3: Fault Reporting and Breakdown Work Orders (FR-M-04, FR-M-05, FR-M-06). Static
  // segments register BEFORE their parameterized siblings, so /fault-reports and /reliability
  // precede their :id routes and no parameter segment shadows a static one.
  router.post('/api/v1/maintenance/sla-policies', createSlaPolicyHandler);
  router.get('/api/v1/maintenance/sla-policies', listSlaPoliciesHandler);
  router.post('/api/v1/maintenance/fault-reports', createFaultReportHandler);
  router.get('/api/v1/maintenance/fault-reports', listFaultReportsHandler);
  router.get('/api/v1/maintenance/fault-reports/:faultReportId', getFaultReportHandler);
  router.post('/api/v1/maintenance/fault-reports/:faultReportId/accept', acceptFaultReportHandler);
  router.post('/api/v1/maintenance/fault-reports/:faultReportId/reject', rejectFaultReportHandler);
  router.post('/api/v1/maintenance/work-orders/:workOrderId/downtime/close', closeDowntimeHandler);
  router.post('/api/v1/maintenance/reliability/generate', generateReliabilityReportHandler);
  router.get('/api/v1/maintenance/reliability', listReliabilityMetricsHandler);

  // Story 7.4: Spare Parts Cataloguing, Reservation, and Critical-Spares Alerts (FR-M-07, FR-M-08,
  // FR-M-09). ROUTE ORDER MATTERS: '/spares/scan' and '/spares/alerts' MUST be registered before
  // '/spares/:sku/where-used', or the parameter segment shadows both static routes and the scan
  // trigger silently becomes a where-used lookup for a SKU literally named "scan".
  router.post('/api/v1/maintenance/spares', createSpareHandler);
  router.get('/api/v1/maintenance/spares', listSparesHandler);
  router.post('/api/v1/maintenance/spares/scan', scanSparesHandler);
  router.get('/api/v1/maintenance/spares/alerts', listSpareAlertsHandler);
  router.get('/api/v1/maintenance/spares/:sku/where-used', whereUsedHandler);
  router.post('/api/v1/maintenance/assets/:assetId/parts', addAssetPartHandler);
  router.get('/api/v1/maintenance/assets/:assetId/parts', listAssetPartsHandler);
  router.post(
    '/api/v1/maintenance/work-orders/:workOrderId/spare-reservations',
    reserveSpareHandler,
  );
  router.get('/api/v1/maintenance/spare-reservations', listSpareReservationsHandler);
  router.post('/api/v1/maintenance/spare-reservations/:reservationId/issue', issueSpareHandler);
  router.post('/api/v1/maintenance/spare-reservations/:reservationId/return', returnSpareHandler);
  router.post(
    '/api/v1/maintenance/spare-reservations/:reservationId/cancel',
    cancelSpareReservationHandler,
  );

  // Story 7.5: Calibration Register and Non-Overridable Lockout (FR-M-12, FR-M-13, AD-8).
  // ROUTE ORDER MATTERS: every static segment under '/calibration/' is registered before any
  // '/calibration/:param' route, and '/instruments' before '/instruments/:instrumentRecordId', or
  // the parameter segment shadows the static ones and the scan trigger silently becomes a lookup
  // for an instrument literally named "scan". These live under '/api/v1/maintenance/instruments';
  // the Story 1.7 admin endpoints stay under '/api/v1/instruments' and the two prefixes are
  // distinct, so neither block shadows the other.
  router.post('/api/v1/maintenance/calibration/scan', scanCalibrationHandler);
  router.get('/api/v1/maintenance/calibration/alerts', listCalibrationAlertsHandler);
  router.get('/api/v1/maintenance/calibration/escalations', listCalibrationEscalationsHandler);
  router.post(
    '/api/v1/maintenance/calibration/escalations/:escalationId/resolve',
    resolveCalibrationEscalationHandler,
  );
  router.post('/api/v1/maintenance/instruments', createInstrumentHandler);
  router.get('/api/v1/maintenance/instruments', listInstrumentsHandler);
  router.get('/api/v1/maintenance/instruments/:instrumentRecordId', getInstrumentHandler);
  router.post(
    '/api/v1/maintenance/instruments/:instrumentRecordId/certificates',
    recordCertificateHandler,
  );
  router.get(
    '/api/v1/maintenance/instruments/:instrumentRecordId/certificates',
    listCertificatesHandler,
  );
  router.post(
    '/api/v1/maintenance/instruments/:instrumentRecordId/escalations',
    raiseCalibrationEscalationHandler,
  );

  // Story 7.6: statutory examinations, cost accumulation, and machine status broadcast
  // (FR-M-14, FR-M-15, FR-M-16). ROUTE ORDER MATTERS: '/statutory-examinations/scan' is registered
  // BEFORE '/statutory-examinations/:examinationId', and the literal list segments '/asset-status'
  // and '/asset-costs' BEFORE their parameterized '/assets/:assetId/...' siblings - the router
  // returns the first match in registration order and ':param' compiles to ([^/]+). None of these
  // shadows the existing '/assets/:assetId/parts' routes (distinct literal segments).
  router.post('/api/v1/maintenance/statutory-examinations', createStatutoryExaminationHandler);
  router.get('/api/v1/maintenance/statutory-examinations', listStatutoryExaminationsHandler);
  router.post('/api/v1/maintenance/statutory-examinations/scan', scanStatutoryExaminationsHandler);
  router.get(
    '/api/v1/maintenance/statutory-examinations/:examinationId',
    getStatutoryExaminationHandler,
  );
  router.get('/api/v1/maintenance/asset-status', listAssetStatusesHandler);
  router.get('/api/v1/maintenance/asset-costs', listAssetCostsHandler);
  router.get('/api/v1/maintenance/assets/:assetId/status', getAssetStatusHandler);
  router.post('/api/v1/maintenance/assets/:assetId/status', setAssetStatusHandler);
  router.get('/api/v1/maintenance/assets/:assetId/costs', getAssetCostsHandler);

  // Story 7.7: AMC, warranty, and insurance tracking (FR-M-10, FR-M-11). ROUTE ORDER MATTERS: the
  // literal '/coverages', '/coverages/alerts' and '/coverages/scan' segments are all registered
  // BEFORE '/coverages/:coverageId' - the router returns the first match in registration order and
  // ':param' compiles to ([^/]+), so a parameter route placed first would swallow both the alerts
  // list and the scan trigger. The '/assets/:assetId/coverages' and
  // '/work-orders/:workOrderId/warranty-overrides' routes carry distinct literal tail segments, so
  // they shadow none of the existing '/assets/:assetId/...' or '/work-orders/:workOrderId/...'
  // siblings.
  router.post('/api/v1/maintenance/assets/:assetId/coverages', recordCoverageHandler);
  router.get('/api/v1/maintenance/assets/:assetId/coverages', listAssetCoveragesHandler);
  router.get('/api/v1/maintenance/coverages', listCoveragesHandler);
  router.get('/api/v1/maintenance/coverages/alerts', listCoverageAlertsHandler);
  router.post('/api/v1/maintenance/coverages/scan', scanCoveragesHandler);
  router.get('/api/v1/maintenance/coverages/:coverageId', getCoverageHandler);
  router.post(
    '/api/v1/maintenance/work-orders/:workOrderId/warranty-overrides',
    recordWarrantyOverrideHandler,
  );
  router.get(
    '/api/v1/maintenance/work-orders/:workOrderId/warranty-overrides',
    getWarrantyOverrideHandler,
  );

  // Story 6.1: Production Order Creation and Release Gate (FR-MO-01/02/03). ROUTE ORDER MATTERS:
  // '/production-orders' (both verbs) is registered BEFORE any '/production-orders/:orderId' route,
  // and the three sub-resource routes after the bare '/:orderId' route, so no parameter segment
  // shadows the list route. The '/api/v1/production-orders' prefix is distinct from the existing
  // '/api/v1/purchase-orders' block; a careless parameter route placed before the list route would
  // swallow it, which is the exact defect this ordering prevents.
  router.post('/api/v1/production-orders', createProductionOrderHandler);
  router.get('/api/v1/production-orders', listProductionOrdersHandler);
  router.get('/api/v1/production-orders/:orderId', getProductionOrderHandler);
  router.get('/api/v1/production-orders/:orderId/release-gate', getProductionReleaseGateHandler);
  router.post('/api/v1/production-orders/:orderId/release', releaseProductionOrderHandler);
  router.post('/api/v1/production-orders/:orderId/transition', transitionProductionOrderHandler);
  router.post('/api/v1/production-orders/:orderId/cancel', cancelProductionOrderHandler);

  // Story 6.2: Material Staging, Issue, and WIP Ledger (FR-MO-04/05/06). ROUTE ORDER MATTERS:
  // the six routes carry distinct literal tail segments after the shared '/:orderId' parameter, so
  // none of them shadows the existing '/production-orders/:orderId' siblings or each other. The
  // two GET routes (staging worklist, wip) stay out of the way of the four POST writes.
  router.post('/api/v1/production-orders/:orderId/material-staging', stageMaterialHandler);
  router.get('/api/v1/production-orders/:orderId/material-staging', listStagingHandler);
  router.post('/api/v1/production-orders/:orderId/material-issues', issueMaterialHandler);
  router.post('/api/v1/production-orders/:orderId/confirmations', recordConfirmationHandler);
  router.post('/api/v1/production-orders/:orderId/material-returns', returnMaterialHandler);
  router.get('/api/v1/production-orders/:orderId/wip', getWipHandler);

  // Story 4.7: Supplier Invoice Capture
  router.post('/api/v1/supplier-invoices', captureSupplierInvoiceHandler);
  router.post('/api/v1/supplier-invoices/duplicate-overrides', captureDuplicateOverrideHandler);
  router.get('/api/v1/supplier-invoices/:invoiceId', getSupplierInvoiceHandler);
  router.get('/api/v1/supplier-invoices', listSupplierInvoicesHandler);
  router.post('/api/v1/supplier-invoices/:invoiceId/link-po', linkSupplierInvoiceToPoHandler);
  router.post('/api/v1/supplier-invoice-ingestions', stageInvoiceIngestionHandler);
  router.get('/api/v1/supplier-invoice-ingestions', listInvoiceIngestionsHandler);
  router.get('/api/v1/supplier-invoice-ingestions/:ingestionId', getInvoiceIngestionHandler);
  router.post(
    '/api/v1/supplier-invoice-ingestions/:ingestionId/confirm',
    confirmInvoiceIngestionHandler,
  );
  // Story 4.6: MSME Compliance Tracking - ageing report, ERP feed run, daily compliance check
  router.get('/api/v1/compliance/msme/ageing', msmeAgeingReportHandler);
  router.post('/api/v1/compliance/msme/ageing-feed/run', runMsmeAgeingFeedHandler);
  router.post('/api/v1/compliance/msme/daily-check', runMsmeDailyCheckHandler);

  // Story 4.5: goods receipt and three-way match - native PO binding on a Story 3.4 GRN, the
  // PO/receipt/invoice match, the credit and debit notes that lift a blocked match, and the ERP
  // payment-clearance feed that a blocked invoice is withheld from.
  router.post('/api/v1/grns/:grnId/link-po', linkGrnToPoHandler);
  router.post('/api/v1/three-way-match/run', runThreeWayMatchHandler);
  router.get('/api/v1/three-way-match', listThreeWayMatchesHandler);
  router.get('/api/v1/three-way-match/:matchId', getThreeWayMatchHandler);
  router.post('/api/v1/supplier-invoices/:invoiceId/credit-note', recordCreditNoteHandler);
  router.post('/api/v1/supplier-invoices/:invoiceId/debit-note', recordDebitNoteHandler);
  router.post('/api/v1/compliance/payment-clearance-feed/run', runPaymentClearanceFeedHandler);
  router.get('/api/v1/compliance/payment-clearance-feed/eligible', listClearanceEligibleHandler);

  // Story 4.2: Supplier Performance Scorecards - consolidated trend read plus drill-through, and
  // the three thin metric write routes (quality acceptance intentionally has no write route
  // until Epic 8 lands its qc.lot_dispositioned source).
  router.get('/api/v1/supplier-scorecards/:supplierId', getSupplierScorecardHandler);
  router.get(
    '/api/v1/supplier-scorecards/:supplierId/transactions',
    listSupplierScorecardTransactionsHandler,
  );
  router.post('/api/v1/grns/:grnId/scorecard/on-time', recordOnTimeDeliveryMetricHandler);
  router.post(
    '/api/v1/three-way-match/:matchId/scorecard/price-variance',
    recordPriceVarianceMetricHandler,
  );
  router.post(
    '/api/v1/purchase-orders/:poId/scorecard/responsiveness',
    recordResponsivenessMetricHandler,
  );

  // Story 3.6: Pick Task Generation and Execution
  router.post('/api/v1/pick-tasks/generate', generatePickTasksHandler);
  router.post('/api/v1/pick-tasks/wave', generateWavePickTasksHandler);
  router.post('/api/v1/pick-tasks/batch', generateBatchPickTasksHandler);
  router.get('/api/v1/pick-tasks', listPickTasksHandler);
  router.get('/api/v1/pick-tasks/:pickTaskId', getPickTaskHandler);
  router.post('/api/v1/pick-tasks/:pickTaskId/assign', assignPickTaskHandler);
  router.post('/api/v1/pick-tasks/:pickTaskId/lines/:pickLineId/confirm', confirmPickLineHandler);
  router.post('/api/v1/pick-tasks/:pickTaskId/complete', completePickTaskHandler);
  router.get('/api/v1/pick-tasks/:pickTaskId/print', printPickTaskHandler);

  // Story 3.7: Packing, Shipping, and Dispatch Documents
  router.post('/api/v1/dispatch/:dispatchOrderId/pack', postPacked);
  router.post(
    '/api/v1/dispatch/:dispatchOrderId/generate-documents',
    postShippingDocumentsGenerated,
  );
  router.post('/api/v1/dispatch/:dispatchOrderId/dispatch', postDispatched);
  router.get('/api/v1/dispatch/:dispatchOrderId/packing-records', getPackingRecords);
  router.get('/api/v1/dispatch/:dispatchOrderId/documents', getDispatchDocuments);
  router.get('/api/v1/packing-records/:packingRecordId', getPackingRecord);
  router.get('/api/v1/dispatch-order-status/:dispatchOrderId', getDispatchOrderStatusHandler);
  router.get('/api/v1/dispatch/documents/:documentId', getDispatchDocument);

  router.get('/api/v1/lots/:lot_id/trace', getLotTraceHandler);
  router.post('/api/v1/stock/:sku/select-lot', selectLotHandler);
  router.put('/api/v1/lots/:lot_id/quality-hold', placeQualityHoldHandler);
  router.delete('/api/v1/lots/:lot_id/quality-hold', clearQualityHoldHandler);
  router.put('/api/v1/instruments/:id/calibration-status', updateCalibrationStatusHandler);
  router.post('/api/v1/qc/results', createQcResultHandler);
  router.post(
    '/api/v1/instruments/:id/calibration-escalations',
    createCalibrationEscalationHandler,
  );
  router.get('/api/v1/edge/bootstrap', edgeBootstrapHandler);
  router.get('/api/v1/edge/powersync-credentials', powerSyncCredentialsHandler);
  router.post('/api/v1/edge/events', edgeEventUploadHandler);
  router.get('/api/v1/notifications', listNotificationsHandler);
  router.get('/api/v1/notifications/unread-count', getUnreadCountHandler);
  router.patch('/api/v1/notifications/:id', updateNotificationHandler);
  router.post('/api/v1/notifications/:id/acknowledge', acknowledgeNotificationHandler);
  router.get('/api/v1/notifications/preferences', getPreferencesHandler);
  router.put('/api/v1/notifications/preferences', putPreferencesHandler);
  router.post('/api/v1/notifications/push-subscription', createPushSubscriptionHandler);
  router.delete('/api/v1/notifications/push-subscription', deletePushSubscriptionHandler);

  if (config.auth.mode === 'local') {
    router.post('/api/v1/auth/dev-token', devTokenHandler);
  }

  return router;
}

export function createAppServer(router: Router = createAppRouter()): Server {
  return createServer((req, res) => {
    router.handle(req, res).catch((err) => {
      console.error('Unhandled server error:', err);
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({
            error_code: 'INTERNAL_ERROR',
            message: 'Internal server error',
            details: {},
            trace_id: 'unknown',
          }),
        );
      }
    });
  });
}

const server = createAppServer();

// Story 1.11: the notification dispatcher, escalation clock, and expiry sweep run as in-process
// intervals rather than a separate `notify` container/CD job - see Dev Notes Task 6.2. They only
// start inside startServer() (the real running process), never when a test builds its own
// Router/Server directly, so tests control cycle timing explicitly via runDispatchCycle()/
// runEscalationCycle()/runExpiryCycle() instead of racing a background timer.
let dispatchTimer: ReturnType<typeof setInterval> | undefined;
let escalationTimer: ReturnType<typeof setInterval> | undefined;
let expiryTimer: ReturnType<typeof setInterval> | undefined;

/**
 * Wraps a poll-cycle in a re-entrancy guard: setInterval does NOT skip a tick while the async
 * callback from the previous tick is still pending, so a cycle slower than its interval would
 * otherwise overlap itself and double-process. The guard drops a tick that fires while the
 * previous run is still in flight. (Cross-process overlap - a second app instance - is separately
 * bounded by the atomic claim in the dispatcher and the claim-then-act in the escalator.)
 */
function guarded(name: string, cycle: () => Promise<unknown>): () => void {
  let running = false;
  return () => {
    if (running) return;
    running = true;
    cycle()
      .catch((err) => console.error(`Notification ${name} cycle failed:`, err))
      .finally(() => {
        running = false;
      });
  };
}

function startServer(): void {
  server.listen(config.port, config.hostname, () => {
    console.log(`Server listening on http://${config.hostname}:${config.port}`);
    console.log(`Environment: ${config.nodeEnv}`);
  });

  dispatchTimer = setInterval(
    guarded('dispatch', () => runDispatchCycle()),
    config.notify.dispatchIntervalMs,
  );
  escalationTimer = setInterval(
    guarded('escalation', () => runEscalationCycle()),
    config.notify.escalationIntervalMs,
  );
  expiryTimer = setInterval(
    guarded('expiry', () => runExpiryCycle()),
    config.notify.expiryIntervalMs,
  );

  const stopTimers = (): void => {
    clearInterval(dispatchTimer);
    clearInterval(escalationTimer);
    clearInterval(expiryTimer);
  };

  process.on('SIGTERM', () => {
    console.log('SIGTERM received. Shutting down gracefully...');
    stopTimers();
    server.close(async () => {
      const { closePool } = await import('./config/db.js');
      await closePool();
      console.log('Server and database connections closed.');
      process.exit(0);
    });
  });

  process.on('SIGINT', () => {
    console.log('SIGINT received. Shutting down gracefully...');
    stopTimers();
    server.close(async () => {
      const { closePool } = await import('./config/db.js');
      await closePool();
      console.log('Server and database connections closed.');
      process.exit(0);
    });
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  startServer();
}

export { server };
