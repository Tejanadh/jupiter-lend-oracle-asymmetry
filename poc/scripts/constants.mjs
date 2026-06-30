/** Jupiter Lend mainnet targets for Chainlink Data Streams staleness PoC */

export const ORACLE_PROGRAM_ID = "jupnw4B6Eqs7ft6rxpzYLJZYSnrpRgPcr589n5Kv4oc";
export const VAULTS_PROGRAM_ID = "jupr81YtYssSyPt8jbnGuiWon5f6x9TcDEFxYe3Bdzi";
export const LIQUIDITY_PROGRAM_ID = "jupeiUmn818Jg1ekPURTpr4mFo29p46vygyykFJ3wZC";

export const VERIFIER_PROGRAM_ID = "Gt9S41PtjR58CbG9JhJ3J6vxesqrNAswbWYbLNTMZA3c";
export const VERIFIER_ACCOUNT = "HJR45sRiFdGncL69HVzRK4HLS2SXcVW3KeTPkp2aFmWC";
export const ACCESS_CONTROLLER = "7mSn5MoBjyRLKoJShgkep8J17ueGG8rYioVAiSg5YWMF";
export const CONFIG_ACCOUNT = "DvhXV68YnA43KsnkKxnT2zW5ERj4vMPDwKB7nvFHyZdT";
export const KEEPER = "4Q2scHgUyjaVTH6zr6bUdx2vRqN9QvQtqircgJQ17rEW";

/** Primary PoC pair: oracle nonce 62 → cache nonce 3 */
export const TARGET = {
  oracle: "DuX7B4gKvXPbBhQGXv4mD5FiFYf8C3EE8Pm5eh42mGiT",
  cache: "A2GDb4Um4Tr42iKgPz5fQ2d7pYTnaUuHN3d5V41Cywff",
  oracleNonce: 62,
  cacheNonce: 3,
};

export const ALL_PAIRS = [
  {
    oracle: "DuX7B4gKvXPbBhQGXv4mD5FiFYf8C3EE8Pm5eh42mGiT",
    cache: "A2GDb4Um4Tr42iKgPz5fQ2d7pYTnaUuHN3d5V41Cywff",
    oracleNonce: 62,
    cacheNonce: 3,
  },
  {
    oracle: "Fa1zDwJrXzZUyoUjmoojPrEQseYSW9M5xy2LmcDPPCHc",
    cache: "A4RuZpjfbdzo1fQTqu1ng7kNya1knC2fHSSG5Sv4G4EH",
    oracleNonce: 61,
    cacheNonce: 2,
  },
  {
    oracle: "Hxkqy3LBkuUcx3DPGSAaMV4Vfyh5rzX2i4n7yQNwAdTx",
    cache: "BJWkdfRiH2Yroomx27VS1TxGxPWcfQoXHMmafBY7apZo",
    oracleNonce: 60,
    cacheNonce: 1,
  },
  {
    oracle: "8UJfPZinaPs6C4UKWb6CmeLgTbQThMyB7AJFYCFpHwoi",
    cache: "DLuv79r7JPgdF2C266h1kuX8DPhg2amDtaTqz9Zm25w1",
    oracleNonce: 63,
    cacheNonce: 4,
  },
];

export const MAX_AGE_OPERATE_SECS = 600;
export const STALE_WARP_SECS = 601;

/** Anchor discriminators from oracle.json IDL */
export const IX_DISC = {
  getExchangeRateOperate: Buffer.from([174, 166, 126, 10, 122, 153, 94, 203]),
  getExchangeRateLiquidate: Buffer.from([228, 169, 73, 39, 91, 82, 27, 5]),
  getBothExchangeRate: Buffer.from([153, 76, 17, 194, 170, 215, 89, 142]),
};

/** Known oracle error codes (from IDL + c4-audit) */
export const ERROR_CODES = {
  PriceTooOld: 6002,
  ChainlinkDataStreamsPriceTooOld: 6021,
  ChainlinkDataStreamsObservationTimestampTooOld: 6028,
};
