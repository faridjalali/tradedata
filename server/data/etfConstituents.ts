/**
 * Hardcoded ETF constituent ticker arrays.
 * Updated manually on quarterly rebalances.
 * Last updated: 2025-02 (approximate — verify against live sources before running bootstrap).
 *
 * Note: Tickers with dots (BRK.B, BF.B) are stored here with dots.
 * The data API may use different separators — normalisation happens at fetch time.
 *
 * Official constituent lists: https://www.ssga.com/us/en/intermediary/etfs/fund-finder
 * (download the holdings CSV for each ETF to get the exact current composition)
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
// XLK — Technology Select Sector SPDR (S&P 500 Information Technology)
// ---------------------------------------------------------------------------
export const XLK_CONSTITUENTS: string[] = [
  'AAPL','MSFT','NVDA','AVGO','ORCL','CRM','AMD','QCOM','AMAT','LRCX',
  'INTC','INTU','ADBE','KLAC','ANET','SNPS','CDNS','CSCO','PANW','ACN',
  'TXN','ADI','MCHP','NXPI','SWKS','FTNT','PLTR','SMCI','KEYS','AKAM',
  'GEN','MPWR','GDDY','IT','HPQ','HPE','CDW','JNPR','NTAP','TER',
  'ANSS','PTC','TRMB','EPAM','CTSH','MSCI','VRSN','FICO','FFIV','BR',
  'WDC','STX','ZBRA','JKHY','GLW','ON','IBM','NOW','CRWD','TDY',
  'APH','TEL','PAYC','FI','FISV','MSI',
];

// ---------------------------------------------------------------------------
// XLF — Financials Select Sector SPDR (S&P 500 Financials)
// ---------------------------------------------------------------------------
export const XLF_CONSTITUENTS: string[] = [
  'JPM','BAC','WFC','GS','MS','C','BRK.B','AXP','SCHW','CB',
  'BLK','MMC','PGR','ICE','CME','AON','USB','PNC','MET','TFC',
  'PRU','AIG','AFL','TRV','AJG','CINF','WTW','CBOE','NDAQ','BK',
  'STT','NTRS','IVZ','RJF','AMP','TROW','BEN','FDS','COF','DFS',
  'SYF','FITB','RF','HBAN','KEY','MTB','CFG','ERIE','ACGL','AIZ',
  'BX','GL','L','MKTX','FCNCA','SPGI','MCO','V','MA','PYPL',
  'FIS','FI','FISV','BRO','PFG','WRB',
];

// ---------------------------------------------------------------------------
// XLV — Health Care Select Sector SPDR (S&P 500 Health Care)
// ---------------------------------------------------------------------------
export const XLV_CONSTITUENTS: string[] = [
  'UNH','LLY','JNJ','ABBV','MRK','TMO','ABT','ISRG','DHR','AMGN',
  'SYK','BSX','EW','VRTX','REGN','CI','CVS','MDT','HCA','BDX',
  'DXCM','IQV','HUM','BMY','PFE','GILD','BIIB','MRNA','INCY','A',
  'ZBH','CNC','MOH','DVA','PODD','RMD','TFX','WAT','MTD','BIO',
  'TECH','CRL','HOLX','HSIC','IDXX','RVTY','STE','BAX','SOLV','GEHC',
  'DGX','LH','MCK','CAH','COR','VTRS',
];

// ---------------------------------------------------------------------------
// XLY — Consumer Discretionary Select Sector SPDR (S&P 500 Cons. Discretionary)
// ---------------------------------------------------------------------------
export const XLY_CONSTITUENTS: string[] = [
  'AMZN','TSLA','HD','MCD','BKNG','LOW','TJX','NKE','SBUX','TGT',
  'ORLY','YUM','APTV','F','GM','LVS','MGM','MAR','GRMN','DRI',
  'DPZ','EXPE','NCLH','CCL','RCL','LULU','ROST','TSCO','ULTA','PHM',
  'DHI','NVR','TPR','RL','PVH','HAS','LKQ','BWA','DECK','MHK',
  'LYV','WYNN','CZR','BLDR','ABNB','LEN','BBY','KMX','CMG','AZO',
  'POOL','GPC','EBAY',
];

// ---------------------------------------------------------------------------
// XLC — Communication Services Select Sector SPDR (S&P 500 Comm. Services)
// ---------------------------------------------------------------------------
export const XLC_CONSTITUENTS: string[] = [
  'META','GOOGL','GOOG','NFLX','CMCSA','T','VZ','DIS','EA','WBD',
  'TMUS','TTWO','IPG','OMC','MTCH','FOXA','FOX','NWS','NWSA','LYV',
  'CHTR','DASH','RBLX',
];

// ---------------------------------------------------------------------------
// XLI — Industrials Select Sector SPDR (S&P 500 Industrials)
// ---------------------------------------------------------------------------
export const XLI_CONSTITUENTS: string[] = [
  'GEV','HON','RTX','CAT','UPS','LMT','DE','NOC','EMR','ITW',
  'CTAS','ETN','ROK','WM','RSG','CARR','OTIS','PCAR','WAB','JBHT',
  'CHRW','NSC','UNP','CSX','BA','GD','TDG','HWM','FTV','FAST',
  'AME','GWW','ROP','MSI','GNRC','LDOS','HUBB','LHX','TT','IR',
  'PWR','J','ODFL','DAY','SWK','AOS','ALLE','TXT','URI','XYL',
  'AXON','FDX','MMM','GE','EXPD','MAS','NDSN','IEX','PH','PAYX',
  'DAL','UAL','LUV','AAL','SNA','CMI','DOV','ITW','ROL','VRSK',
  'CPRT','FLR','LDOS',
];

// ---------------------------------------------------------------------------
// XLP — Consumer Staples Select Sector SPDR (S&P 500 Consumer Staples)
// ---------------------------------------------------------------------------
export const XLP_CONSTITUENTS: string[] = [
  'PG','KO','PEP','COST','WMT','PM','MO','MDLZ','CL','KMB',
  'EL','MNST','KHC','STZ','SJM','KR','HSY','GIS','CPB','CAG',
  'MKC','CLX','CHD','HRL','TSN','WBA','BG','KVUE','LW','TAP',
  'KDP','SYY','ADM','K',
];

// ---------------------------------------------------------------------------
// XLE — Energy Select Sector SPDR (S&P 500 Energy)
// ---------------------------------------------------------------------------
export const XLE_CONSTITUENTS: string[] = [
  'XOM','CVX','COP','EOG','SLB','MPC','VLO','OXY','PSX','HAL',
  'DVN','FANG','APA','BKR','HES','OKE','WMB','KMI','TRGP','MRO',
  'CTRA','EQT',
];

// ---------------------------------------------------------------------------
// XLU — Utilities Select Sector SPDR (S&P 500 Utilities)
// ---------------------------------------------------------------------------
export const XLU_CONSTITUENTS: string[] = [
  'NEE','DUK','SO','D','AEP','SRE','EXC','XEL','ED','EIX',
  'WEC','PPL','DTE','ETR','EVRG','LNT','AES','NRG','CNP','NI',
  'ATO','PNW','ES','VST','CMS','PEG','AWK','CEG','FE','PCG',
];

// ---------------------------------------------------------------------------
// XLRE — Real Estate Select Sector SPDR (S&P 500 Real Estate)
// ---------------------------------------------------------------------------
export const XLRE_CONSTITUENTS: string[] = [
  'PLD','AMT','EQIX','CCI','PSA','SPG','SBAC','WELL','EXR','DLR',
  'AVB','EQR','VTR','ARE','O','INVH','WY','UDR','CPT','BXP',
  'CSGP','IRM','HST','VICI','REG','FRT','KIM','MAA','ESS','CBRE',
  'SUI',
];

// ---------------------------------------------------------------------------
// XLB — Materials Select Sector SPDR (S&P 500 Materials)
// ---------------------------------------------------------------------------
export const XLB_CONSTITUENTS: string[] = [
  'LIN','SHW','APD','ECL','FCX','NEM','NUE','VMC','MLM','ALB',
  'DD','DOW','LYB','CE','SEE','PPG','EMN','AVY','IP','PKG',
  'MOS','FMC','CF','CTVA','IFF','BG',
];

// ---------------------------------------------------------------------------
// XBI — SPDR S&P Biotech ETF (equal-weighted S&P Biotech Select Industry)
// Includes many small/mid-cap names outside S&P 500.
// ---------------------------------------------------------------------------
export const XBI_CONSTITUENTS: string[] = [
  'MRNA','BIIB','REGN','VRTX','GILD','ALNY','EXAS','SRPT','INCY','EXEL',
  'BMRN','ARWR','IONS','NBIX','RARE','HALO','PRGO','UTHR','PCVX','KRYS',
  'ACAD','AXSM','MRTX','DNLI','EDIT','NTLA','BEAM','FATE','TGTX','VCEL',
  'RCUS','IMVT','KYMR','MRUS','ROIV','BCRX','BHVN','BPMC','CLDX','CMPS',
  'CORT','CPRX','CYTK','DVAX','FOLD','HIMS','INSM','ITCI','ITOS','JANX',
  'KROS','LGND','MDGL','MGNX','MNKD','NKTR','NVAX','PATK','PTGX','PTCT',
  'RGEN','RYTM','SAGE','SAVA','SEER','SMMT','SPRY','STOK','TBPH','TCRX',
  'TENX','TVTX','TWST','VKTX','VRNA','XNCR','YMAB','ZLAB','ZNTL','AKRO',
  'ALEC','ALPN','ANAB','APLS','ARCT','ARDX','ARQT','ASND','ATXS','BBIO',
  'BLUE','BNOX','BNTX','CARA','CLLS','CNMD','CRBU','CYFX','DCPH','DMTK',
];

// ---------------------------------------------------------------------------
// XHB — SPDR S&P Homebuilders ETF (S&P Homebuilders Select Industry)
// ---------------------------------------------------------------------------
export const XHB_CONSTITUENTS: string[] = [
  'DHI','LEN','PHM','NVR','BLDR','TOL','MDC','MHO','SKY','LGIH',
  'GRBK','TMHC','IBP','BECN','FBHS','MAS','TREX','FTDR','AWI','DOOR',
  'LPX','SSD','AZEK','OC','TT','CARR','ALLE','JELD','CSL','STC',
  'FND','LL','TILE','AMWD','PATK',
];

// ---------------------------------------------------------------------------
// XRT — SPDR S&P Retail ETF (equal-weighted S&P Retail Select Industry)
// ---------------------------------------------------------------------------
export const XRT_CONSTITUENTS: string[] = [
  'AMZN','HD','TGT','LOW','COST','TJX','ROST','BKNG','ORLY','AZO',
  'BBY','KMX','TSCO','ULTA','W','PRTY','BOOT','BIG','CATO','CHWY',
  'CONN','CPSS','CVNA','DKS','DLTR','DG','EXPR','FL','FLXS','FTDR',
  'GRWG','GCO','GME','GPS','HAR','HIBB','HOFT','JWN','LESL','LKQ',
  'M','MNSO','MNTN','MRVL','NWLI','ODP','ORLY','PLCE','PRPL','PSMT',
  'RH','RVLV','SCVL','SHOO','SIG','SPWH','TJX','TH','TLYS','TPR',
  'URBN','VFC','VSCO','WBA','WINA','WSM','YETI','ZGN',
];

// ---------------------------------------------------------------------------
// XAR — SPDR S&P Aerospace & Defense ETF (S&P Aerospace & Defense Select Industry)
// ---------------------------------------------------------------------------
export const XAR_CONSTITUENTS: string[] = [
  'RTX','LMT','NOC','GD','BA','LHX','TDG','HWM','LDOS','TXT',
  'HEI','AXON','SAIC','DRS','KTOS','MRCY','CW','AIR','AJRD','AVAV',
  'DCO','ERJ','ESLT','FLIR','GHC','HAYN','HEICO','JAMF','MOOG','MRNA',
  'PLTR','PSN','RCAT','SPR','SPCE','SWBI','TGI','TRMK','TS','VSE',
];

// ---------------------------------------------------------------------------
// KRE — SPDR S&P Regional Banking ETF (S&P Regional Banks Select Industry)
// Includes many smaller regional banks not in S&P 500.
// ---------------------------------------------------------------------------
export const KRE_CONSTITUENTS: string[] = [
  'USB','PNC','TFC','FITB','RF','HBAN','KEY','MTB','CFG','FCNCA',
  'EWBC','BOH','BOKF','CADE','CATY','CBSH','CFR','CMA','COLB','CVBF',
  'EBC','FFIN','FHN','FNB','FULT','GABC','GBCI','GNBC','HAFC','HOMB',
  'HTH','IBOC','INDB','ISBC','IBTX','LKFN','NBT','NBTB','NFBK','NWBI',
  'OFG','ONB','OPBK','PACW','PFIS','PFS','PNFP','PPBI','PRSP','RNST',
  'SASR','SBCF','SFNC','SIVB','SKBK','SNV','SRCE','SSB','STBA','TCBI',
  'TFSL','TRMK','UBSI','UMPQ','UMBF','UVSP','VBTX','VLY','WAL','WBS',
  'WSFS','WTFC','ZION','BANF','BANR','BUSE','BWFG','CARE','CBTX','CLBK',
  'CVLY','CZWI','DCOM','EBSB','EFSC','EGBN','EMCF','ESSA','EVBN','FBIZ',
  'FBNC','FCCO','FCNB','FFBH','FFBW','FGBI','FISI','FMBH','FMNB','FNWB',
  'FONR','FUNC','GFED','GNTY','GPMT','GSBC','HAFC','HBT','HCAT','HEES',
  'HFWA','HGBL','HMST','HNRG','HOPE','HTBK','HTLF','HVBC','HZNP','IBCP',
  'IBTX','IROQ','JMSB','KBAL','KRNY','LAKE','LBAI','LBCP','LCNB','LMST',
  'MBIN','MCBC','MFIN','MFNB','MGEE','MNSB','MOFG','MPWR','MRBK','MRTN',
];

// ---------------------------------------------------------------------------
// DIA — SPDR Dow Jones Industrial Average ETF (30 DJIA components)
// As of early 2025: NVDA replaced INTC (Nov 2024), AMZN replaced WBA (Feb 2024)
// ---------------------------------------------------------------------------
export const DIA_CONSTITUENTS: string[] = [
  'AAPL','AMGN','AMZN','AXP','BA','CAT','CRM','CSCO','CVX','DIS',
  'GS','HD','HON','IBM','JNJ','JPM','KO','MCD','MMM','MRK',
  'MSFT','NKE','NVDA','PG','SHW','TRV','UNH','V','VZ','WMT',
];

// ---------------------------------------------------------------------------
// MDY — SPDR S&P MidCap 400 ETF (~400 tickers)
// Representative subset; download full list from SPDR for exact composition.
// ---------------------------------------------------------------------------
export const MDY_CONSTITUENTS: string[] = [
  'AAON','ABG','ABM','ACHC','ADEA','ADNT','AEL','AFG','AGCO','AIN',
  'AIR','AIT','AKR','AL','ALEX','ALK','ALKS','AM','AMCX','AMG',
  'AMKR','AMS','AN','ANDE','ANF','APAM','APG','APOG','APPF','ARCO',
  'ARCB','ARW','ASB','ASH','ASGN','ATGE','ATRI','AVNT','AXNX','AYI',
  'AZPN','BCPC','BCO','BE','BFH','BHE','BKE','BLMN','BLTE','BNL',
  'BOX','BRC','BRKR','BRP','BSIG','BTU','BURL','CABO','CAKE','CATY',
  'CBRL','CCOI','CDRE','CFLT','CHRD','CIR','CIVI','CKH','CLFD','CLH',
  'COLL','COLM','COMP','CPK','CROX','CRUS','CRVL','CSL','CSWI','CWK',
  'CWT','CWST','DBRG','DFIN','DLB','DMRC','DPH','DSSI','DV','DVAX',
  'DWS','EAT','ECVT','EDR','EHC','EIG','ELME','ENOV','ENSG','ENVA',
  'EPC','EPRT','ESAB','ESTE','ETD','EVTC','EXLS','EXPO','EXTR','EYE',
  'FANG','FARO','FBP','FCFS','FCN','FDP','FFIN','FHI','FIVN','FLGT',
  'FLO','FLO','FLS','FMC','FRAF','FRME','FRSH','FSTR','FUL','FULT',
  'GATX','GBCI','GEF','GFF','GH','GHL','GIL','GLT','GMS','GNRC',
  'GNTX','GPC','GPOR','GPX','GRBK','GVA','HCC','HCI','HCSG','HEES',
  'HFWA','HIIQ','HLIT','HLX','HMSY','HNRG','HNI','HOME','HP','HPK',
  'HTH','HUBG','HWKN','IART','ICHR','IDA','IDCC','IDT','IIVI','INDB',
  'INFN','INGR','INT','IOSP','IPAR','ITT','ITGR','IVT','JACK','JELD',
  'JHG','JLL','JOE','JW.A','KAI','KBH','KFY','KNSL','KNX','KRC',
  'KSS','KTOS','LBRT','LCII','LGF.A','LGIH','LHO','LKFN','LNN','LNW',
  'LOPE','LPX','LTC','LUMN','MARA','MATV','MBUU','MCRI','MDU','MEC',
  'MEND','MHK','MIDD','MKSI','MLAB','MMI','MMSI','MMS','MNDY','MNRO',
  'MOFG','MRCY','MRC','MSA','MSCI','MTRN','MTW','MTX','MUR','NAVI',
  'NBHC','NBT','NEU','NHC','NHI','NIC','NKTR','NLIGHT','NLSN','NNN',
  'NOG','NSP','NUS','NVT','NWBI','NWLI','NYT','OFIX','OGS','OMCL',
  'OMFL','OMF','ONTO','ORN','OSBC','OSGB','OTTR','OUT','OXM','PAGP',
  'PAHC','PANL','PARR','PATK','PDCE','PDM','PFSI','PGC','PGRE','PHX',
  'PIPR','PLUS','PNM','POWL','PPD','PRGS','PRK','PROS','PSB','PSMT',
  'PTEN','PTGX','PUMP','PYCR','QCRH','RDNT','REX','RGA','RGLD','RGP',
  'RHP','RITM','RLJ','RMR','RPM','RPAY','RUSHA','RXO','RYCEY','RYAM',
  'SAFE','SAMG','SANM','SBH','SBT','SCSC','SIGI','SKT','SKYW','SLCA',
  'SMAR','SMG','SNX','SONO','SRI','SSD','SSYS','STAA','STBA','STEP',
  'STIG','STR','STRL','SUM','SUPN','SVRA','SWBI','SWI','SWX','SXI',
  'SYBT','SYNH','SYX','TACO','TCBK','TCMD','TDS','TENB','THG','THRM',
  'THS','TILE','TMDX','TNET','TNK','TOWN','TPVG','TREX','TRNO','TRUP',
  'TTGT','TWNK','TXRH','UE','UHAL','UNF','UNIT','URBN','UTMD','UVV',
  'VBTX','VCEL','VCNX','VG','VIAV','VIEW','VIRT','VMI','VNO','VNT',
  'VRTS','VSCO','VSTO','VVX','WDFC','WEN','WERN','WETF','WFRD','WHD',
  'WSBC','WSFS','WU','WYNN','XPO','XRAY','YETI','ZLAB','ZEUS','ZURN',
];

// ---------------------------------------------------------------------------
// SLY — SPDR S&P 600 Small Cap ETF (~600 tickers)
// Representative subset; download full list from SPDR for exact composition.
// ---------------------------------------------------------------------------
export const SLY_CONSTITUENTS: string[] = [
  'AAOI','AAON','ABCB','ABMD','ABR','ACLS','ACNB','ACT','ACVA','ADUS',
  'AEIS','AEO','AGM','AGYS','AHCO','AHH','AIOT','AIV','AIXI','AJRD',
  'AKAM','AKTS','ALCO','ALGM','ALGT','ALKT','ALUR','AMBC','AMCX','AMED',
  'AMEH','AMGN','AMID','AMK','AMPH','AMRX','AMSC','AMWD','ANGI','ANIP',
  'ANNA','APAT','APEI','APLT','APOG','APPN','APRE','APTI','APW','ARLO',
  'ARVL','ASIX','ASLE','ASPN','ASTE','ASYS','ATEC','ATEX','ATNI','ATNX',
  'ATRC','ATSG','ATUS','ATXS','AUMN','AVID','AVNS','AXNX','AXON','AYRO',
  'AZIPM','BAND','BANF','BANR','BCAN','BCRX','BCSA','BFST','BGCP','BGS',
  'BHLB','BIGY','BKD','BKNG','BKU','BLDE','BLU','BMBL','BMO','BNFT',
  'BOCH','BRKR','BRP','BRSP','BSIG','BSM','BSVN','BTB','BTBT','BUSE',
  'BYFC','BZH','CACC','CADE','CAKE','CALB','CALM','CAMP','CARG','CASH',
  'CATO','CBFV','CBNK','CBRL','CBSH','CCO','CCRN','CCSI','CDMO','CDRE',
  'CFBK','CFFI','CFFN','CFLT','CGEN','CGNT','CHCO','CHRS','CHUY','CIR',
  'CIVB','CIVG','CKX','CLDT','CLFD','CLF','CLNE','CLNC','CLPR','CMCO',
  'CMGE','CMLS','CMLF','CMRE','CNDT','CNET','CNS','CNSL','CNVY','COD',
  'CODX','CODI','COIN','COKE','COMT','CONN','COOK','COOP','CORE','CORR',
  'COWN','CPF','CPIX','CPLG','CPLP','CREX','CRK','CRNC','CRNT','CROX',
  'CRRX','CRTO','CRT','CRY','CSGS','CSTE','CTBI','CTLP','CTMX','CTRI',
  'CTS','CUBA','CULP','CUZ','CVBF','CVE','CVET','CVGW','CVLY','CWBC',
  'CWD','CWST','CYCN','CYBE','CYCC','CYCL','CZWI','DAR','DBD','DBRG',
  'DBVT','DCOM','DFIN','DFH','DGICA','DGX','DHT','DIBS','DIOD','DKNG',
  'DLHC','DMRC','DNJR','DNOW','DOMA','DPSI','DQS','DSGX','DSSI','DTST',
  'DUTY','DVAX','DXC','DXNG','DXPE','DXYN','DYAI','DYNS','EAST','EBC',
  'EBIX','EBSB','EFSC','EGHT','EGL','EGBN','EGRX','EMCF','EMXC','ENOB',
  'ENSG','ENVA','EPAX','EPIQ','EPRT','ESES','ESSA','ESXB','ETC','ETH',
  'ETWO','EURN','EVBN','EVER','EVLO','EVOP','EVTC','EXAM','EXLA','EXPC',
  'EXPI','EXPO','EXPR','FARO','FBIZ','FBMS','FBP','FBSS','FCCO','FCNB',
  'FCRX','FCUV','FDEF','FDMT','FEND','FFBH','FFBW','FGBI','FHCO','FISI',
  'FLIC','FLMN','FLXS','FMAO','FMBH','FMNB','FNLC','FNWB','FOLT','FONR',
  'FOR','FORR','FOUR','FRBA','FRBK','FSBW','FSCO','FSEA','FSI','FUNC',
  'FXNC','GCBC','GDEN','GFED','GGAL','GHL','GHLD','GHVI','GLDD','GNBC',
  'GNTY','GPMT','GRWG','GSBC','GSIT','HAFC','HBT','HCAT','HEES','HHR',
  'HIBB','HIHO','HJLI','HOFT','HQY','HRMY','HTBK','HTBI','HTLF','HVBC',
  'HWKN','HYDW','HYLN','IAA','IART','IBCP','IBIO','IBOC','IBTX','ICG',
  'ICLR','ICUI','IDEV','IDEX','IDGT','IDSA','IFBD','IIIN','IIIV','IIVI',
  'IMMR','INDB','INFU','INGR','INSG','INTL','IOSP','IPAR','IPGP','IROQ',
  'ISBC','ISDR','ISEE','ISNS','ISRP','ISS','IVAC','IVCB','IVPT','JMSB',
  'JNST','JOUT','JRSH','JVSA','KBAL','KELYA','KFRC','KGRN','KHAV','KNSA',
  'KRNY','KRON','LAKE','LBAI','LBCP','LCII','LCNB','LCUT','LEGH','LGND',
  'LILA','LIQT','LKFN','LMNL','LMST','LNDC','LNTH','LOCO','LPRO','LQDT',
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export type BreadthIndex =
  | 'SPY' | 'QQQ' | 'SMH'
  | 'XLK' | 'XLF' | 'XLV' | 'XLY' | 'XLC' | 'XLI'
  | 'XLP' | 'XLE' | 'XLU' | 'XLRE' | 'XLB'
  | 'XBI' | 'XHB' | 'XRT' | 'XAR' | 'KRE'
  | 'DIA' | 'MDY' | 'SLY';

const INDEX_MAP: Record<BreadthIndex, string[]> = {
  SPY:  SP500_CONSTITUENTS,
  QQQ:  QQQ_CONSTITUENTS,
  SMH:  SMH_CONSTITUENTS,
  XLK:  XLK_CONSTITUENTS,
  XLF:  XLF_CONSTITUENTS,
  XLV:  XLV_CONSTITUENTS,
  XLY:  XLY_CONSTITUENTS,
  XLC:  XLC_CONSTITUENTS,
  XLI:  XLI_CONSTITUENTS,
  XLP:  XLP_CONSTITUENTS,
  XLE:  XLE_CONSTITUENTS,
  XLU:  XLU_CONSTITUENTS,
  XLRE: XLRE_CONSTITUENTS,
  XLB:  XLB_CONSTITUENTS,
  XBI:  XBI_CONSTITUENTS,
  XHB:  XHB_CONSTITUENTS,
  XRT:  XRT_CONSTITUENTS,
  XAR:  XAR_CONSTITUENTS,
  KRE:  KRE_CONSTITUENTS,
  DIA:  DIA_CONSTITUENTS,
  MDY:  MDY_CONSTITUENTS,
  SLY:  SLY_CONSTITUENTS,
};

export function getConstituentsForIndex(index: BreadthIndex): string[] {
  return INDEX_MAP[index] ?? [];
}

export const ALL_BREADTH_INDICES: BreadthIndex[] = [
  'SPY', 'QQQ', 'SMH',
  'XLK', 'XLF', 'XLV', 'XLY', 'XLC', 'XLI',
  'XLP', 'XLE', 'XLU', 'XLRE', 'XLB',
  'XBI', 'XHB', 'XRT', 'XAR', 'KRE',
  'DIA', 'MDY', 'SLY',
];

/** Union of all constituent tickers across all ETFs (for filtering grouped bars). */
export const ALL_BREADTH_TICKERS: Set<string> = new Set([
  ...SP500_CONSTITUENTS,
  ...QQQ_CONSTITUENTS,
  ...SMH_CONSTITUENTS,
  // XL sector ETFs + DIA are subsets of SP500_CONSTITUENTS — no new tickers
  ...XBI_CONSTITUENTS,
  ...XHB_CONSTITUENTS,
  ...XRT_CONSTITUENTS,
  ...XAR_CONSTITUENTS,
  ...KRE_CONSTITUENTS,
  ...MDY_CONSTITUENTS,
  ...SLY_CONSTITUENTS,
]);
