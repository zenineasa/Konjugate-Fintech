/* Copyright © 2026 Zenin Easa Panthakkalakath */

// Groups of Yahoo Finance symbols the Markets window offers to add in one go. Yahoo has no list of a category's members, so
// these are chosen by hand and each symbol was checked to answer. Edit this file to change them.
export const baskets = [
    {
        "name": "Major indices",
        "about": "Broad market indices from the US, Europe and Asia, plus the VIX.",
        "members": [
            {
                "symbol": "^GSPC",
                "label": "S&P 500"
            },
            {
                "symbol": "^IXIC",
                "label": "Nasdaq Composite"
            },
            {
                "symbol": "^DJI",
                "label": "Dow Jones"
            },
            {
                "symbol": "^RUT",
                "label": "Russell 2000"
            },
            {
                "symbol": "^FTSE",
                "label": "FTSE 100"
            },
            {
                "symbol": "^GDAXI",
                "label": "DAX"
            },
            {
                "symbol": "^FCHI",
                "label": "CAC 40"
            },
            {
                "symbol": "^N225",
                "label": "Nikkei 225"
            },
            {
                "symbol": "^HSI",
                "label": "Hang Seng"
            },
            {
                "symbol": "^STOXX50E",
                "label": "Euro Stoxx 50"
            },
            {
                "symbol": "^VIX",
                "label": "VIX"
            }
        ]
    },
    {
        "name": "US sectors",
        "about": "The eleven SPDR sector funds that split the S&P 500.",
        "members": [
            {
                "symbol": "XLK",
                "label": "Technology"
            },
            {
                "symbol": "XLF",
                "label": "Financials"
            },
            {
                "symbol": "XLE",
                "label": "Energy"
            },
            {
                "symbol": "XLV",
                "label": "Health care"
            },
            {
                "symbol": "XLY",
                "label": "Consumer discretionary"
            },
            {
                "symbol": "XLP",
                "label": "Consumer staples"
            },
            {
                "symbol": "XLI",
                "label": "Industrials"
            },
            {
                "symbol": "XLB",
                "label": "Materials"
            },
            {
                "symbol": "XLU",
                "label": "Utilities"
            },
            {
                "symbol": "XLRE",
                "label": "Real estate"
            },
            {
                "symbol": "XLC",
                "label": "Communication services"
            }
        ]
    },
    {
        "name": "Commodities",
        "about": "Front-month futures for energy, metals and grains.",
        "members": [
            {
                "symbol": "CL=F",
                "label": "WTI crude"
            },
            {
                "symbol": "BZ=F",
                "label": "Brent crude"
            },
            {
                "symbol": "NG=F",
                "label": "Natural gas"
            },
            {
                "symbol": "GC=F",
                "label": "Gold"
            },
            {
                "symbol": "SI=F",
                "label": "Silver"
            },
            {
                "symbol": "HG=F",
                "label": "Copper"
            },
            {
                "symbol": "PL=F",
                "label": "Platinum"
            },
            {
                "symbol": "ZC=F",
                "label": "Corn"
            },
            {
                "symbol": "ZW=F",
                "label": "Wheat"
            },
            {
                "symbol": "ZS=F",
                "label": "Soybeans"
            },
            {
                "symbol": "KC=F",
                "label": "Coffee"
            },
            {
                "symbol": "SB=F",
                "label": "Sugar"
            },
            {
                "symbol": "CT=F",
                "label": "Cotton"
            }
        ]
    },
    {
        "name": "Interest rates",
        "about": "US Treasury yields, read as changes in percentage points.",
        "members": [
            {
                "symbol": "^IRX",
                "label": "13-week yield"
            },
            {
                "symbol": "^FVX",
                "label": "5-year yield"
            },
            {
                "symbol": "^TNX",
                "label": "10-year yield"
            },
            {
                "symbol": "^TYX",
                "label": "30-year yield"
            }
        ]
    },
    {
        "name": "Currencies",
        "about": "Major exchange rates and the US dollar index.",
        "members": [
            {
                "symbol": "EURUSD=X",
                "label": "EUR/USD"
            },
            {
                "symbol": "GBPUSD=X",
                "label": "GBP/USD"
            },
            {
                "symbol": "USDJPY=X",
                "label": "USD/JPY"
            },
            {
                "symbol": "USDCHF=X",
                "label": "USD/CHF"
            },
            {
                "symbol": "AUDUSD=X",
                "label": "AUD/USD"
            },
            {
                "symbol": "USDCAD=X",
                "label": "USD/CAD"
            },
            {
                "symbol": "USDCNY=X",
                "label": "USD/CNY"
            },
            {
                "symbol": "DX-Y.NYB",
                "label": "US dollar index"
            }
        ]
    },
    {
        "name": "Crypto",
        "about": "The largest cryptocurrencies. They trade every day, which shortens the shared calendar.",
        "members": [
            {
                "symbol": "BTC-USD",
                "label": "Bitcoin"
            },
            {
                "symbol": "ETH-USD",
                "label": "Ethereum"
            },
            {
                "symbol": "SOL-USD",
                "label": "Solana"
            }
        ]
    },
    {
        "name": "Asset-class funds",
        "about": "One fund per broad asset class: equities, bonds, gold, oil, real estate.",
        "members": [
            {
                "symbol": "SPY",
                "label": "US large caps"
            },
            {
                "symbol": "QQQ",
                "label": "Nasdaq 100"
            },
            {
                "symbol": "IWM",
                "label": "US small caps"
            },
            {
                "symbol": "EFA",
                "label": "Developed markets ex-US"
            },
            {
                "symbol": "EEM",
                "label": "Emerging markets"
            },
            {
                "symbol": "AGG",
                "label": "US bonds"
            },
            {
                "symbol": "TLT",
                "label": "Long Treasuries"
            },
            {
                "symbol": "HYG",
                "label": "High-yield bonds"
            },
            {
                "symbol": "LQD",
                "label": "Investment-grade bonds"
            },
            {
                "symbol": "GLD",
                "label": "Gold fund"
            },
            {
                "symbol": "USO",
                "label": "Oil fund"
            },
            {
                "symbol": "VNQ",
                "label": "US real estate"
            },
            {
                "symbol": "DBC",
                "label": "Commodities fund"
            }
        ]
    },
    {
        "name": "Country funds",
        "about": "One fund per country, for cross-market links.",
        "members": [
            {
                "symbol": "EWJ",
                "label": "Japan"
            },
            {
                "symbol": "EWG",
                "label": "Germany"
            },
            {
                "symbol": "EWU",
                "label": "United Kingdom"
            },
            {
                "symbol": "EWZ",
                "label": "Brazil"
            },
            {
                "symbol": "FXI",
                "label": "China large caps"
            },
            {
                "symbol": "INDA",
                "label": "India"
            },
            {
                "symbol": "EWY",
                "label": "South Korea"
            },
            {
                "symbol": "EWW",
                "label": "Mexico"
            },
            {
                "symbol": "EWC",
                "label": "Canada"
            },
            {
                "symbol": "EWA",
                "label": "Australia"
            }
        ]
    },
    {
        "name": "Industries",
        "about": "Industry funds, including gold miners and airlines.",
        "members": [
            {
                "symbol": "SMH",
                "label": "Semiconductors"
            },
            {
                "symbol": "XBI",
                "label": "Biotech"
            },
            {
                "symbol": "KBE",
                "label": "Banks"
            },
            {
                "symbol": "JETS",
                "label": "Airlines"
            },
            {
                "symbol": "XME",
                "label": "Metals and mining"
            },
            {
                "symbol": "GDX",
                "label": "Gold miners"
            },
            {
                "symbol": "OIH",
                "label": "Oil services"
            },
            {
                "symbol": "ITA",
                "label": "Aerospace and defence"
            }
        ]
    }
];
