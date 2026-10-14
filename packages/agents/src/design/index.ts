/** Architect: sizing, provider options and costs, code-change derivation and the design phase. */
export { backgroundJobLibraries, backgroundJobsWarning } from "./background-jobs";
export {
  type CodeChange,
  type CodeChangeSignals,
  collectCodeChangeSignals,
  deriveCodeChanges,
  type HealthRoute,
  healthRouteFor,
  type ScanFindings,
} from "./code-changes";
export {
  convertMoney,
  costFor,
  EXCHANGE_RATE_NOTE,
  formatMoney,
  priceLabel,
  roundCents,
  USD_PER_EUR,
} from "./cost";
export {
  type BuildDesignOptionsInput,
  buildDesignOptions,
  type DesignTier,
  minimumMonthlyCost,
} from "./options";
export {
  buildOwnServerOption,
  OWN_SERVER_BACKUPS_NOTE,
  OWN_SERVER_LOCATION,
  OWN_SERVER_OPTION_ID,
  OWN_SERVER_PRICE_NOTE,
  OWN_SERVER_TYPE,
  type OwnServerAccess,
  type OwnServerDesign,
  type OwnServerOptionInput,
  tunnelNeedsCloudflareDomain,
} from "./own";
export { appNameFor, appPortFor, type OptionToPlanInput, optionToPlan } from "./plan";
export { type ReleaseCommandNote, releaseCommandNote } from "./release";
export {
  type DesignPreview,
  type DesignResult,
  type OwnServerDesignInput,
  type PreviewDesignOptions,
  previewDesignOptions,
  type RunDesignOptions,
  runDesign,
} from "./run";
export {
  LOCATION_NAMES,
  OWN_SERVER_MEMORY_TOLERANCE,
  ownServerFreeDiskGb,
  regionLocations,
  type Sizing,
  sizeFor,
} from "./sizing";
