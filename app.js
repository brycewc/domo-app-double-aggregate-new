// ==========================================================
// Category Revenue Growth – Double Aggregation Bar Chart
//
// Overcomes Domo beast-mode double-aggregation limitation
// by performing the FIXED (BY ouName) logic client-side
// after fetching server-side aggregated data via domo.get().
//
// Beast mode being replaced:
//   CASE WHEN variable = 'Season Year' THEN
//     CASE WHEN `seasonSplitYearGrouping` = MAX(MAX(...)) FIXED (BY ouName) THEN  SUM(...)
//          WHEN `seasonSplitYearGrouping` = MIN(MIN(...)) FIXED (BY ouName) THEN -SUM(...)
//     END
//   ... (similar for Season, Calendar Year)
//   END
// ==========================================================

/* global DomoPhoenix */
const { Chart, CHART_TYPE, DATA_TYPE, MAPPING } = DomoPhoenix;

const DATASET_ALIAS = 'revenue';

const COLORS = {
	positive: '#8ec2e1',
	negative: '#e1574f'
};

// Map Domo variable values to the dataset column that determines periods
const PERIOD_VARIABLE_TO_COLUMN = {
	'Season Year': 'seasonSplitYearGrouping',
	Season: 'seasonSplit',
	'Calendar Year': 'fiscalYear'
};

// Map Domo variable values to the dataset column used as y-axis categories
const CATEGORY_VARIABLE_TO_COLUMN = {
	Category: 'category',
	'Product Line': 'productLine',
	'Category Product Line': 'categoryProductLine'
};

const DEFAULT_PERIOD_VARIABLE = 'Season Year';
const DEFAULT_CATEGORY_VARIABLE = 'Category';

// Track current variables so event handlers can access them
let currentPeriodVariable = DEFAULT_PERIOD_VARIABLE;
let currentCategoryVariable = DEFAULT_CATEGORY_VARIABLE;
// Page-level filters from onFiltersUpdated, merged into each query
let currentPageFilters = [];
// Cache last rendered data for resize
let cachedData = null;
let cachedTitle = '';
let cachedTotal = 0;

// Phoenix chart instance
let chart = null;

// ----------------------------------------------------------
// Formatting
// ----------------------------------------------------------

function formatTotal(value) {
	const abs = Math.abs(value);
	if (abs >= 1e9) return '$' + (abs / 1e9).toFixed(2) + 'B';
	if (abs >= 1e6) return '$' + (abs / 1e6).toFixed(2) + 'M';
	if (abs >= 1e3) return '$' + (abs / 1e3).toFixed(2) + 'K';
	return '$' + abs.toFixed(2);
}

// ----------------------------------------------------------
// Data: query + double-aggregation logic
// ----------------------------------------------------------

function getPeriodColumn(variableValue) {
	return PERIOD_VARIABLE_TO_COLUMN[variableValue] || PERIOD_VARIABLE_TO_COLUMN[DEFAULT_PERIOD_VARIABLE];
}

function getCategoryColumn(variableValue) {
	return CATEGORY_VARIABLE_TO_COLUMN[variableValue] || CATEGORY_VARIABLE_TO_COLUMN[DEFAULT_CATEGORY_VARIABLE];
}

// Convert a page filter object from onFiltersUpdated into the
// Domo filter expression DSL accepted by domo.data.query's `filter`
// option, so it can be AND-ed with our hardcoded chan filter.
function quoteValue(v, dataType) {
	if (v === null || v === undefined) return 'null';
	if (dataType === 'NUMBER' || dataType === 'DOUBLE' || dataType === 'LONG' || typeof v === 'number') {
		return String(v);
	}
	return "'" + String(v).replace(/'/g, "''") + "'";
}

function pageFilterToExpr(f) {
	if (!f || !f.column || !f.operator) return null;
	const col = f.column;
	const vals = f.values || [];
	const dt = f.dataType;
	const q = (v) => quoteValue(v, dt);
	switch (f.operator) {
		// Comparison
		case 'EQUALS':
			return col + '=' + q(vals[0]);
		case 'NOT_EQUALS':
			return col + '!=' + q(vals[0]);
		case 'GREATER_THAN':
			return col + '>' + q(vals[0]);
		case 'GREAT_THAN_EQUALS_TO':
			return col + '>=' + q(vals[0]);
		case 'LESS_THAN':
			return col + '<' + q(vals[0]);
		case 'LESS_THAN_EQUALS_TO':
			return col + '<=' + q(vals[0]);
		case 'BETWEEN':
			// No native BETWEEN operator — express as two comma-joined comparisons
			if (vals.length < 2) return null;
			return col + '>=' + q(vals[0]) + ',' + col + '<=' + q(vals[1]);
		// List membership
		case 'IN':
			return vals.length ? col + ' in [' + vals.map(q).join(',') + ']' : null;
		case 'NOT_IN':
			return vals.length ? col + ' !in [' + vals.map(q).join(',') + ']' : null;
		// Substring — DSL only has contains; STARTS_WITH/ENDS_WITH approximated
		case 'CONTAINS':
		case 'STARTS_WITH':
		case 'ENDS_WITH':
			return vals.length ? col + ' ~ ' + q(vals[0]) : null;
		case 'NOT_CONTAINS':
		case 'NOT_STARTS_WITH':
		case 'NOT_ENDS_WITH':
			return vals.length ? col + ' !~ ' + q(vals[0]) : null;
		default:
			return null;
	}
}

function buildFilter() {
	const base = "chan!='Warehouse Transfer/Placeholder'";
	const extras = currentPageFilters.map(pageFilterToExpr).filter(Boolean);
	return [base, ...extras].join(',');
}

/**
 * Fetch data using domo.data.query with server-side aggregation.
 * Groups by ouName + categoryColumn + period column, sums totalAmountUsd.
 * Combines the chan exclusion filter with any page-level filters so the
 * chart respects dashboard filters.
 */
function fetchData(periodColumn, categoryColumn) {
	const options = {
		fields: ['ouName', categoryColumn, periodColumn, 'totalAmountUsd'],
		groupBy: ['ouName', categoryColumn, periodColumn],
		sum: ['totalAmountUsd'],
		filter: buildFilter(),
		format: 'array-of-objects'
	};
	return domo.data.query(DATASET_ALIAS, options);
}

/**
 * Client-side FIXED (BY ouName) logic:
 *   For each ouName:
 *     - Find the MAX period → "newer" period → positive sum
 *     - Find the MIN period → "older" period → negative sum
 *   Then re-group results by the selected category column
 *   (Category, Product Line, or Category Product Line).
 *
 * This replaces the beast mode's double-aggregation that Domo can't handle.
 */
function computeGrowth(rows, periodColumn, categoryColumn) {
	// Group by ouName to determine max/min periods per ouName (FIXED BY ouName)
	const ouGroups = {};
	rows.forEach((row) => {
		const ou = row.ouName;
		if (!ou) return;
		if (!ouGroups[ou]) ouGroups[ou] = [];
		ouGroups[ou].push(row);
	});

	// Find max and min period per ouName
	const ouMaxMin = {};
	Object.keys(ouGroups).forEach((ou) => {
		const periods = ouGroups[ou].map((r) => r[periodColumn]).filter(Boolean);
		if (periods.length === 0) return;
		ouMaxMin[ou] = {
			max: periods.reduce((a, b) => (a > b ? a : b)),
			min: periods.reduce((a, b) => (a < b ? a : b))
		};
	});

	// Accumulate growth by the selected category column
	const categoryTotals = {};

	rows.forEach((r) => {
		const ou = r.ouName;
		const cat = r[categoryColumn];
		if (!ou || !cat || !ouMaxMin[ou]) return;

		const { max, min } = ouMaxMin[ou];
		if (max === min) return;

		const period = r[periodColumn];
		const amount = +r.totalAmountUsd || 0;

		if (!categoryTotals[cat]) categoryTotals[cat] = 0;

		if (period === max) categoryTotals[cat] += amount;
		else if (period === min) categoryTotals[cat] -= amount;
	});

	const results = Object.keys(categoryTotals).map((category) => ({
		category,
		value: categoryTotals[category]
	}));

	// Sort by value descending
	results.sort((a, b) => b.value - a.value);

	return results;
}

// ----------------------------------------------------------
// Chart title
// ----------------------------------------------------------

/**
 * Dynamic title: "{Period Variable} {min} vs {max} {Category Variable} Revenue Growth"
 * Example: "Season Years 2021 vs 2022 Category Revenue Growth"
 */
function buildTitle(periodVariable, categoryVariable, rows, periodColumn) {
	const seen = {};
	const periods = [];
	rows.forEach((r) => {
		const p = r[periodColumn];
		if (p && !seen[p]) {
			seen[p] = true;
			periods.push(p);
		}
	});
	periods.sort();

	const minP = periods[0] || '?';
	const maxP = periods[periods.length - 1] || '?';
	const periodLabel = periodVariable || 'Season Years';
	const categoryLabel = categoryVariable || 'Category';

	return periodLabel + ' ' + minP + ' vs ' + maxP + ' ' + categoryLabel + ' Revenue Growth';
}

// ----------------------------------------------------------
// Phoenix Horizontal Bar Chart
// ----------------------------------------------------------

function renderChart(data) {
	const container = document.getElementById('chart');
	container.innerHTML = '';
	chart = null;

	if (!data || data.length === 0) return;

	const phoenixData = {
		columns: [
			{ type: DATA_TYPE.STRING, name: 'Category', mapping: MAPPING.ITEM },
			{ type: DATA_TYPE.STRING, name: 'Growth Type', mapping: MAPPING.SERIES },
			{ type: DATA_TYPE.DOUBLE, name: 'Revenue Growth', mapping: MAPPING.VALUE }
		],
		rows: data.map((d) => [d.category, d.value >= 0 ? 'Growth' : 'Decline', d.value])
	};

	const options = {
		width: container.clientWidth || 600,
		height: container.clientHeight || 400,
		colors: [COLORS.positive, COLORS.negative],
		properties: {
			datalabel_use_scale_abbrev: 'true',
			datalabel_use_scale_format: 'true',
			datalabel_show_total: 'true',
			datalabel_total_style: 'Medium'
		}
	};

	chart = new Chart(CHART_TYPE.HORIZ_BAR, phoenixData, options);
	container.appendChild(chart.canvas);
	chart.render();
}

// ----------------------------------------------------------
// Process + render pipeline
// ----------------------------------------------------------

function updateHeader(title, total) {
	document.getElementById('chart-title').textContent = title;
	document.getElementById('chart-total').innerHTML =
		'<span class="amount">' + formatTotal(total) + '</span>' + '<span class="label">Total</span>';
}

function processAndRender(rows, periodVariable, categoryVariable) {
	const periodColumn = getPeriodColumn(periodVariable);
	const categoryColumn = getCategoryColumn(categoryVariable);
	const data = computeGrowth(rows, periodColumn, categoryColumn);
	const total = data.reduce((sum, d) => sum + d.value, 0);
	const title = buildTitle(periodVariable, categoryVariable, rows, periodColumn);

	cachedData = data;
	cachedTitle = title;
	cachedTotal = total;

	updateHeader(title, total);
	renderChart(data);
}

async function loadAndRender() {
	const periodColumn = getPeriodColumn(currentPeriodVariable);
	const categoryColumn = getCategoryColumn(currentCategoryVariable);
	try {
		const rows = await fetchData(periodColumn, categoryColumn);
		processAndRender(rows, currentPeriodVariable, currentCategoryVariable);
	} catch (err) {
		// DomoAuthError must be checked before DomoHttpError — it extends DomoHttpError.
		if (err instanceof Domo.DomoAuthError) {
			console.error('Auth failed:', err.status, err.statusText);
		} else if (err instanceof Domo.DomoHttpError) {
			console.error('HTTP error:', err.status, err.statusText, err.body);
		} else if (err instanceof Domo.DomoConnectionError) {
			console.error('Network error:', err.message);
		} else if (err instanceof Domo.DomoTimeoutError) {
			console.error('Request timed out:', err.url);
		} else if (err instanceof Domo.DomoValidationError) {
			console.error('Validation error:', err.errors);
		} else {
			throw err;
		}
	}
}

// ----------------------------------------------------------
// Init: event listeners + first load
// ----------------------------------------------------------

// Listen for Domo variable changes.
// v6 passes an array of { name, value, functionId } — look up by name
// so the app works across instances (functionIds differ per instance).
const PERIOD_VARIABLE_NAME = 'Season/Year/Fiscal_DL';
const CATEGORY_VARIABLE_NAME = 'Cat/PL/Cat-PL_DL';

domo.onVariablesUpdated((variables) => {
	// variables is an object keyed by functionId; each entry has
	// { name, functionName, parsedExpression: { value, ... } }
	const list = variables ? Object.values(variables) : [];
	const periodVar = list.find((v) => v && v.name === PERIOD_VARIABLE_NAME);
	const categoryVar = list.find((v) => v && v.name === CATEGORY_VARIABLE_NAME);

	if (periodVar && periodVar.parsedExpression) currentPeriodVariable = periodVar.parsedExpression.value;
	if (categoryVar && categoryVar.parsedExpression) currentCategoryVariable = categoryVar.parsedExpression.value;

	loadAndRender();
});

domo.onDataUpdated((alias) => {});

domo.onFiltersUpdated((filters) => {
	currentPageFilters = Array.isArray(filters) ? filters : [];
	loadAndRender();
});

// Resize: use Phoenix resize from cache (no re-fetch)
let resizeTimer;
window.addEventListener('resize', () => {
	clearTimeout(resizeTimer);
	resizeTimer = setTimeout(() => {
		if (chart) {
			const container = document.getElementById('chart');
			chart.resize(container.clientWidth, container.clientHeight);
		}
	}, 200);
});

// Initial load
loadAndRender();
