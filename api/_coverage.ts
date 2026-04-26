// Shared coverage list. Mirrors REPORTS in index.html.
// When you add or remove a ticker, update both this file and index.html.

export type Coverage = {
  ticker: string;
  company: string;
  sector: string;
  exchange: string;
};

export const COVERAGE: Coverage[] = [
  { ticker: "TNZ.TO", company: "Tenaz Energy Corp.", sector: "Energy (Oil & Gas)", exchange: "TSX" },
  { ticker: "HUT", company: "Hut 8 Corp.", sector: "Digital Assets", exchange: "NASDAQ" },
  { ticker: "FTG.TO", company: "Firan Technology Group", sector: "Aerospace & Defense", exchange: "TSX" },
  { ticker: "PIF.TO", company: "Polaris Renewable Energy", sector: "Renewable Energy", exchange: "TSX" },
  { ticker: "NILI.V", company: "Surge Battery Metals", sector: "Lithium", exchange: "TSXV" },
  { ticker: "AFM.V", company: "Alphamin Resources", sector: "Tin Mining", exchange: "TSXV" },
  { ticker: "MOS", company: "The Mosaic Company", sector: "Fertilizers", exchange: "NYSE" },
  { ticker: "DEFN.V", company: "Defense Metals Corp", sector: "Rare Earths", exchange: "TSXV" },
];
