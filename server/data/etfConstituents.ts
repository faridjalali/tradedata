/**
 * Hardcoded ETF constituent ticker arrays.
 * Updated manually on quarterly rebalances.
 * Last updated: 2025-02 (approximate — verify against live sources).
 *
 * Note: Tickers with dots (BRK.B, BF.B) are stored here with dots.
 * The data API may use different separators — normalisation happens at fetch time.
 */

// ---------------------------------------------------------------------------
// S&P 500 (~503 tickers — some companies have multiple share classes)
// ---------------------------------------------------------------------------
export const SP500_CONSTITUENTS: string[] = [
  'A','AAL','AAPL','ABBV','ABNB','ABT','ACGL','ACN','ADBE','ADI',
  'ADM','ADP','ADSK','AEE','AEP','AES','AFL','AIG','AIZ','AJG',
  'AKAM','ALB','ALGN','ALL','ALLE','AMAT','AMCR','AMD','AME','AMGN',
  'AMP','AMT','AMZN','ANET','ANSS','AON','AOS','APA','APD','APH',
  'APTV','ARE','ATO','AVB','AVGO','AVY','AWK','AXP','AZO',
  'BA','BAC','BAX','BBY','BDX','BEN','BF.B','BG','BIIB','BIO',
  'BK','BKNG','BKR','BLDR','BLK','BMY','BR','BRK.B','BRO','BSX',
  'BWA','BX','BXP','C','CAG','CAH','CARR','CAT','CB','CBOE',
  'CBRE','CCI','CCL','CDNS','CDW','CE','CEG','CF','CFG','CHD',
  'CHRW','CHTR','CI','CINF','CL','CLX','CMCSA','CME','CMG','CMI',
  'CMS','CNC','CNP','COF','COO','COP','COR','COST','CPAY','CPB',
  'CPRT','CPT','CRL','CRM','CRWD','CSCO','CSGP','CSX','CTAS','CTRA',
  'CTSH','CTVA','CVS','CVX','CZR','D','DAL','DAY','DD','DE',
  'DECK','DFS','DG','DGX','DHI','DHR','DIS','DLR','DLTR','DOV',
  'DOW','DPZ','DRI','DTE','DUK','DVA','DVN','DXCM','EA','EBAY',
  'ECL','ED','EFX','EIX','EL','EMN','EMR','ENPH','EOG','EPAM',
  'EQIX','EQR','EQT','ERIE','ES','ESS','ETN','ETR','EVRG','EW',
  'EXC','EXPD','EXPE','EXR','F','FANG','FAST','FCNCA','FCX','FDS',
  'FDX','FE','FFIV','FI','FICO','FIS','FISV','FITB','FMC','FOX',
  'FOXA','FRT','FSLR','FTNT','FTV','GD','GDDY','GE','GEHC','GEN',
  'GEV','GILD','GIS','GL','GLW','GM','GNRC','GOOG','GOOGL','GPC',
  'GPN','GRMN','GS','GWW','HAL','HAS','HBAN','HCA','HD','HOLX',
  'HON','HPE','HPQ','HRL','HSIC','HST','HSY','HUBB','HUM','HWM',
  'IBM','ICE','IDXX','IEX','IFF','INCY','INTC','INTU','INVH','IP',
  'IPG','IQV','IR','IRM','ISRG','IT','ITW','IVZ','J','JBHT',
  'JBL','JCI','JKHY','JNJ','JNPR','JPM','K','KDP','KEY','KEYS',
  'KHC','KIM','KLAC','KMB','KMI','KMX','KO','KR','KVUE','L',
  'LDOS','LEN','LH','LHX','LIN','LKQ','LLY','LMT','LNT','LOW',
  'LRCX','LULU','LUV','LVS','LW','LYB','LYV','MA','MAA','MAR',
  'MAS','MCD','MCHP','MCK','MCO','MDLZ','MDT','MET','META','MGM',
  'MHK','MKC','MKTX','MLM','MMC','MMM','MNST','MO','MOH','MOS',
  'MPC','MPWR','MRK','MRNA','MRO','MS','MSCI','MSFT','MSI','MTB',
  'MTCH','MTD','MU','NCLH','NDAQ','NDSN','NEE','NEM','NFLX','NI',
  'NKE','NOC','NOW','NRG','NSC','NTAP','NTRS','NUE','NVDA','NVR',
  'NWS','NWSA','NXPI','O','ODFL','OKE','OMC','ON','ORCL','ORLY',
  'OTIS','OXY','PANW','PAYC','PAYX','PCAR','PCG','PEG','PEP','PFE',
  'PFG','PG','PGR','PH','PHM','PKG','PLD','PLTR','PM','PNC',
  'PNR','PNW','PODD','POOL','PPG','PPL','PRU','PSA','PSX','PTC',
  'PVH','PWR','PYPL','QCOM','QRVO','RCL','REG','REGN','RF','RJF',
  'RL','RMD','ROK','ROL','ROP','ROST','RSG','RTX','RVTY','SBAC',
  'SBUX','SCHW','SEE','SHW','SJM','SLB','SMCI','SNA','SNPS','SO',
  'SOLV','SPG','SPGI','SRE','STE','STLD','STT','STX','STZ','SWK',
  'SWKS','SYF','SYK','SYY','T','TAP','TDG','TDY','TECH','TEL',
  'TER','TFC','TFX','TGT','TJX','TMO','TMUS','TPR','TRGP','TRMB',
  'TROW','TRV','TSCO','TSLA','TSN','TT','TTWO','TXN','TXT','TYL',
  'UAL','UBER','UDR','UHS','ULTA','UNH','UNP','UPS','URI','USB',
  'V','VICI','VLO','VLTO','VMC','VRSK','VRSN','VRTX','VST','VTR',
  'VTRS','VZ','WAB','WAT','WBA','WBD','WDC','WEC','WELL','WFC',
  'WM','WMB','WMT','WRB','WST','WTW','WY','WYNN','XEL','XOM',
  'XYL','YUM','ZBH','ZBRA','ZTS',
];

// ---------------------------------------------------------------------------
// Nasdaq-100 / QQQ (~101 tickers)
// ---------------------------------------------------------------------------
export const QQQ_CONSTITUENTS: string[] = [
  'AAPL','ABNB','ADBE','ADI','ADP','ADSK','AEP','AMAT','AMGN','AMZN',
  'ANSS','APP','ARM','ASML','AVGO','AZN','BIIB','BKNG','BKR','CCEP',
  'CDNS','CDW','CEG','CHTR','CMCSA','COST','CPRT','CRWD','CSCO','CSGP',
  'CTAS','CTSH','DASH','DDOG','DLTR','DXCM','EA','EXC','FANG','FAST',
  'FTNT','GEHC','GFS','GILD','GOOG','GOOGL','HON','IDXX','ILMN','INTC',
  'INTU','ISRG','KDP','KHC','KLAC','LRCX','LULU','MAR','MCHP','MDB',
  'MDLZ','MELI','META','MNST','MRVL','MSFT','MU','NFLX','NVDA','NXPI',
  'ODFL','ON','ORLY','PANW','PAYX','PCAR','PDD','PEP','PLTR','PYPL',
  'QCOM','REGN','ROP','ROST','SBUX','SMCI','SNPS','TEAM','TMUS','TSLA',
  'TTD','TTWO','TXN','VRSK','VRTX','WBD','WDAY','XEL','ZS',
];

// ---------------------------------------------------------------------------
// SMH — VanEck Semiconductor ETF (~25 tickers)
// ---------------------------------------------------------------------------
export const SMH_CONSTITUENTS: string[] = [
  'ADI','AMAT','AMD','AMKR','ARM','ASML','AVGO','ENTG','GFS','INTC',
  'KLAC','LRCX','MCHP','MRVL','MU','NXPI','ON','QCOM','SNPS','SWKS',
  'TER','TSM','TXN','UCTT',
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export type BreadthIndex = 'SPY' | 'QQQ' | 'SMH';

const INDEX_MAP: Record<BreadthIndex, string[]> = {
  SPY: SP500_CONSTITUENTS,
  QQQ: QQQ_CONSTITUENTS,
  SMH: SMH_CONSTITUENTS,
};

export function getConstituentsForIndex(index: BreadthIndex): string[] {
  return INDEX_MAP[index] ?? [];
}

export const ALL_BREADTH_INDICES: BreadthIndex[] = ['SPY', 'QQQ', 'SMH'];

/** Union of all constituent tickers across all ETFs (for filtering grouped bars). */
export const ALL_BREADTH_TICKERS: Set<string> = new Set([
  ...SP500_CONSTITUENTS,
  ...QQQ_CONSTITUENTS,
  ...SMH_CONSTITUENTS,
]);
