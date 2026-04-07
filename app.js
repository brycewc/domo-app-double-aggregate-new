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
	Season: 'seasonSplitSort',
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
	return (
		PERIOD_VARIABLE_TO_COLUMN[variableValue] ||
		PERIOD_VARIABLE_TO_COLUMN[DEFAULT_PERIOD_VARIABLE]
	);
}

function getCategoryColumn(variableValue) {
	return (
		CATEGORY_VARIABLE_TO_COLUMN[variableValue] ||
		CATEGORY_VARIABLE_TO_COLUMN[DEFAULT_CATEGORY_VARIABLE]
	);
}

/**
 * Fetch data using domo.get with server-side aggregation.
 * Groups by ouName + categoryColumn + period column, sums totalAmountUsd.
 * Excludes 'Warehouse Transfer/Placeholder' rows via 6chan filter.
 */
function fetchData(periodColumn, categoryColumn) {
	const fields = `ouName,${categoryColumn},${periodColumn},totalAmountUsd,chan`;
	const groupby = `ouName,${categoryColumn},${periodColumn}`;
	return domo.get(
		`/data/v1/${DATASET_ALIAS}?fields=${fields}&groupby=${groupby}&filter=chan!='Warehouse Transfer/Placeholder'`,
		{
			format: 'array-of-objects'
		}
	);
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

	return (
		periodLabel +
		' ' +
		minP +
		' vs ' +
		maxP +
		' ' +
		categoryLabel +
		' Revenue Growth'
	);
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
		rows: data.map((d) => [
			d.category,
			d.value >= 0 ? 'Growth' : 'Decline',
			d.value
		])
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
		'<span class="amount">' +
		formatTotal(total) +
		'</span>' +
		'<span class="label">Total</span>';
}

function processAndRender(rows, periodVariable, categoryVariable) {
	console.log(rows);
	const periodColumn = getPeriodColumn(periodVariable);
	const categoryColumn = getCategoryColumn(categoryVariable);
	const data = computeGrowth(rows, periodColumn, categoryColumn);
	const total = data.reduce((sum, d) => sum + d.value, 0);
	console.log(data);
	const title = buildTitle(
		periodVariable,
		categoryVariable,
		rows,
		periodColumn
	);

	cachedData = data;
	cachedTitle = title;
	cachedTotal = total;

	updateHeader(title, total);
	renderChart(data);
}

function loadAndRender() {
	const periodColumn = getPeriodColumn(currentPeriodVariable);
	const categoryColumn = getCategoryColumn(currentCategoryVariable);
	fetchData(periodColumn, categoryColumn).then((rows) => {
		processAndRender(rows, currentPeriodVariable, currentCategoryVariable);
	});
}

// ----------------------------------------------------------
// Init: event listeners + first load
// ----------------------------------------------------------

// Listen for Domo variable changes
domo.onVariablesUpdated((variables) => {
	if (variables) {
		if (variables['Season/Year/Fiscal_DL']) {
			currentPeriodVariable = variables['Season/Year/Fiscal_DL'];
		}
		if (variables['Cat/PL/Cat-PL_DL']) {
			currentCategoryVariable = variables['Cat/PL/Cat-PL_DL'];
		}
	}
	loadAndRender();
});

// Listen for page filter changes – re-fetch (Query API respects page filters)
domo.onFiltersUpdated(() => {
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
