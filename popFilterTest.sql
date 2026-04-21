CASE
    WHEN `Season/Year/Fiscal_DL` = 'Season Year' THEN CASE
        WHEN `Season Split Year Grouping` = MAX(MAX(`Season Split Year Grouping`)) FIXED(BY `OU_NAME`) THEN SUM(`TOTAL_AMOUNT_USD`)
        WHEN `Season Split Year Grouping` = MIN(MIN(`Season Split Year Grouping`)) FIXED(BY `OU_NAME`) THEN - SUM(`TOTAL_AMOUNT_USD`)
    END
    WHEN `Season/Year/Fiscal_DL` = 'Season' THEN CASE
        WHEN `Season Split Sort` = MAX(MAX(`Season Split Sort`)) FIXED(BY `OU_NAME`) THEN SUM(`TOTAL_AMOUNT_USD`)
        WHEN `Season Split Sort` = MIN(MIN(`Season Split Sort`)) FIXED(BY `OU_NAME`) THEN - SUM(`TOTAL_AMOUNT_USD`)
    END
    WHEN `Season/Year/Fiscal_DL` = 'Calendar Year' THEN CASE
        WHEN `Fiscal Year` = MAX(MAX(`Fiscal Year`)) FIXED(BY `OU_NAME`) THEN SUM(`TOTAL_AMOUNT_USD`)
        WHEN `Fiscal Year` = MIN(MIN(`Fiscal Year`)) FIXED(BY `OU_NAME`) THEN - SUM(`TOTAL_AMOUNT_USD`)
    END
END