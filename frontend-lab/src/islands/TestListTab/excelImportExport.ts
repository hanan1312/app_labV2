import { apiFetch } from '../../lib/apiFetch';

interface LabTest {
  id: number;
  name: string;
  sample_type?: string;
  price: number | string;
}

type TFunc = (path: string, fallback: string, vars?: Record<string, string | number>) => string;

// Makes test-name matching "fuzzy": strips punctuation, extra spaces, and common filler
// words (English & Arabic) so e.g. "CBC Analysis" and "cbc" are recognized as the same test.
// Ported 1:1 from script_lab.js's getStandardizedTestName().
function getStandardizedTestName(name: string | undefined | null): string {
  if (!name) return '';
  let n = name
    .toLowerCase()
    .replace(/[^a-z0-9\u0600-\u06FF\s]/g, '')
    .trim();
  n = n.replace(/\b(analysis|examination|routine|test|profile|assay)\b/g, ' ');
  n = n.replace(/\b(تحليل|فحص|روتين|عينة)\b/g, ' ');
  return n.replace(/\s+/g, ' ').trim();
}

// Tests have a nested "Parameters" table (Test List > "Parameters") that never appears in
// the Test Directory's own visible table — a plain generic table-scrape has no way to see
// it, so this exports Tests and Parameters as two linked sheets in one workbook instead:
// "Parameters" carries a "Test Name" column back to its parent test, which
// processExcelImport() below reads to recreate each test's parameters on import. Formula
// fields (relation_formula/absolute_count_formula) are deliberately left out — they
// reference sibling parameters by internal numeric {id}, which wouldn't mean anything after
// re-import creates fresh rows with new ids.
export async function exportTestsWithParameters(tests: LabTest[], t: TFunc): Promise<void> {
  if (!tests || tests.length === 0) {
    window.showAlert(t('alerts.no_table_to_export', 'Error: No table found to export.'), 'error');
    return;
  }

  const testsSheet = tests.map((test) => ({
    'Test Name': test.name,
    'Sample Type': test.sample_type || '',
    Price: test.price,
  }));

  const parameterRows: Record<string, unknown>[] = [];
  for (const test of tests) {
    try {
      const res = await apiFetch(`/api/lab-tests/${test.id}/parameters`);
      if (!res.ok) continue;
      const params = await res.json();
      params.forEach((p: Record<string, unknown>) => {
        parameterRows.push({
          'Test Name': test.name,
          'Parameter Name': p.name,
          Unit: p.unit || '',
          Method: p.method || '',
          'Ref Low': p.ref_low ?? '',
          'Ref High': p.ref_high ?? '',
          'Reference Range (display)': p.reference_range_text || '',
          'Abnormal Interpretation': p.abnormal_note || '',
          'Gender Specific': p.gender_specific ? 'Yes' : 'No',
          'Ref Low (Male)': p.ref_low_male ?? '',
          'Ref High (Male)': p.ref_high_male ?? '',
          'Ref Low (Female)': p.ref_low_female ?? '',
          'Ref High (Female)': p.ref_high_female ?? '',
        });
      });
    } catch (err) {
      console.error(`Failed to load parameters for test "${test.name}":`, err);
    }
  }

  const workbook = window.XLSX.utils.book_new();
  window.XLSX.utils.book_append_sheet(workbook, window.XLSX.utils.json_to_sheet(testsSheet), 'Tests');
  window.XLSX.utils.book_append_sheet(workbook, window.XLSX.utils.json_to_sheet(parameterRows), 'Parameters');
  window.XLSX.writeFile(workbook, 'test_directory.xlsx');
}

interface ParsedParameter {
  name: string;
  unit: string | null;
  method: string | null;
  ref_low: number | null;
  ref_high: number | null;
  reference_range_text: string | null;
  abnormal_note: string | null;
  gender_specific: boolean;
  ref_low_male: number | null;
  ref_high_male: number | null;
  ref_low_female: number | null;
  ref_high_female: number | null;
}

function lowerKeys(row: Record<string, unknown>): Record<string, unknown> {
  const clean: Record<string, unknown> = {};
  for (const key in row) clean[key.trim().toLowerCase()] = row[key];
  return clean;
}

function numOrNull(v: unknown): number | null {
  return v !== undefined && v !== '' ? parseFloat(String(v)) : null;
}

// Reads back the two-sheet workbook exportTestsWithParameters() produces (or a plain
// single-sheet file built by hand) to recreate tests and, where matched, their parameters.
// `event` is the file input's change event; `tests` is the current list (for fuzzy duplicate
// detection); `onImported` is called once at the end to refresh state everywhere (own React
// list + the vanilla `availableTests` global other still-vanilla features read).
export async function processExcelImport(
  event: Event,
  tests: LabTest[],
  t: TFunc,
  onImported: () => Promise<void>
): Promise<void> {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  if (!file) return;

  window.showAlert(t('alerts.excel_reading_generic', 'Reading Excel file... Please wait.'), 'info');

  const reader = new FileReader();
  reader.onload = async (e) => {
    try {
      const data = new Uint8Array(e.target?.result as ArrayBuffer);
      const workbook = window.XLSX.read(data, { type: 'array' });

      // A workbook from exportTestsWithParameters() names its two sheets explicitly; fall
      // back to "whichever sheet is first" for a plain single-sheet file someone built by
      // hand (unnamed, or named something else entirely) — same leniency the column-name
      // matching below already has.
      const testsSheetName = workbook.SheetNames.includes('Tests') ? 'Tests' : workbook.SheetNames[0];
      const json = window.XLSX.utils.sheet_to_json(workbook.Sheets[testsSheetName]);

      if (json.length === 0) {
        window.showAlert(t('alerts.excel_sheet_empty', 'The Excel sheet is empty.'), 'warn');
        return;
      }

      // Parameters sheet is optional — a plain Tests-only import (no nested data) still
      // works exactly as before. Rows are grouped by their own normalized test name (same
      // normalization as the duplicate-detection below) so "CBC " and "cbc" on the
      // Parameters sheet both attach to a Tests-sheet row named "CBC".
      const parametersByTestName = new Map<string, ParsedParameter[]>();
      if (workbook.SheetNames.includes('Parameters')) {
        const paramRows = window.XLSX.utils.sheet_to_json(workbook.Sheets['Parameters']);
        paramRows.forEach((row) => {
          const cleanRow = lowerKeys(row);
          const forTest = getStandardizedTestName(String(cleanRow['test name'] || ''));
          const paramName = String(cleanRow['parameter name'] || '').trim();
          if (!forTest || !paramName) return;
          const parsed: ParsedParameter = {
            name: paramName,
            unit: String(cleanRow['unit'] || '').trim() || null,
            method: String(cleanRow['method'] || '').trim() || null,
            ref_low: numOrNull(cleanRow['ref low']),
            ref_high: numOrNull(cleanRow['ref high']),
            reference_range_text: String(cleanRow['reference range (display)'] || '').trim() || null,
            abnormal_note: String(cleanRow['abnormal interpretation'] || '').trim() || null,
            gender_specific: ['yes', 'true', '1'].includes(String(cleanRow['gender specific'] || '').trim().toLowerCase()),
            ref_low_male: numOrNull(cleanRow['ref low (male)']),
            ref_high_male: numOrNull(cleanRow['ref high (male)']),
            ref_low_female: numOrNull(cleanRow['ref low (female)']),
            ref_high_female: numOrNull(cleanRow['ref high (female)']),
          };
          if (!parametersByTestName.has(forTest)) parametersByTestName.set(forTest, []);
          parametersByTestName.get(forTest)!.push(parsed);
        });
      }

      // 1. Fuzzy map of existing tests: normalized name -> original database name
      const existingTestsMap = new Map<string, string>();
      tests.forEach((existing) => {
        const normName = getStandardizedTestName(existing.name);
        if (normName) existingTestsMap.set(normName, existing.name);
      });

      const toImport: { name: string; sample_type: string; price: number; _normalizedName: string }[] = [];

      // 2. Loop through every row in the Excel sheet
      for (const row of json) {
        const cleanRow = lowerKeys(row);

        const testName = String(
          cleanRow['test name'] ||
            cleanRow['name'] ||
            cleanRow['test'] ||
            cleanRow['اسم التحليل'] ||
            cleanRow['التحليل'] ||
            cleanRow['الاسم'] ||
            cleanRow['test_name'] ||
            ''
        );
        const sampleType = String(cleanRow['sample type'] || cleanRow['sample'] || cleanRow['نوع العينة'] || cleanRow['العينة'] || cleanRow['sample_type'] || '');
        let price: unknown = cleanRow['price'] ?? cleanRow['cost'] ?? cleanRow['السعر'] ?? cleanRow['التكلفة'] ?? 0;
        if (typeof price === 'string') price = price.replace(/[^0-9.]/g, '');

        if (!testName || !testName.trim()) continue;

        const normalizedExcelName = getStandardizedTestName(testName.trim());
        const payload = {
          name: testName.trim(),
          sample_type: sampleType,
          price: parseFloat(String(price)) || 0,
          _normalizedName: normalizedExcelName,
        };

        // 3. Check for fuzzy duplicates
        if (existingTestsMap.has(normalizedExcelName)) {
          const dbName = existingTestsMap.get(normalizedExcelName);
          const addAnyway = window.confirm(
            `⚠️ DUPLICATE FOUND!\n\n` +
              `Excel Test: "${payload.name}"\n` +
              `Database Match: "${dbName}"\n\n` +
              `Do you want to ADD this test anyway?\n` +
              `[OK] = Add Anyway\n` +
              `[Cancel] = Skip this test`
          );
          if (addAnyway) toImport.push(payload);
        } else {
          toImport.push(payload);
        }
      }

      // 4. Safety check: did they skip everything?
      if (toImport.length === 0) {
        window.showAlert(t('alerts.no_new_tests', 'No new tests to import.'), 'info');
        input.value = '';
        return;
      }

      window.showAlert(t('alerts.importing_tests', 'Importing {count} tests...', { count: toImport.length }), 'info');
      let successCount = 0;
      let paramSuccessCount = 0;

      // 5. Send the final approved list to the database
      for (const payload of toImport) {
        const normalizedName = payload._normalizedName;
        const res = await apiFetch('/api/tests', {
          method: 'POST',
          body: JSON.stringify({ name: payload.name, sample_type: payload.sample_type, price: payload.price }),
        });
        if (!res.ok) continue;
        successCount++;

        // Attach this test's parameters, if the workbook's Parameters sheet had any rows
        // for it — same nested-data round-trip exportTestsWithParameters() sets up on the
        // way out.
        const created = await res.json().catch(() => null);
        const params = created?.id ? parametersByTestName.get(normalizedName) : null;
        if (params) {
          for (const param of params) {
            const paramRes = await apiFetch(`/api/lab-tests/${created.id}/parameters`, {
              method: 'POST',
              body: JSON.stringify(param),
            });
            if (paramRes.ok) paramSuccessCount++;
          }
        }
      }

      // 6. Clean up and refresh
      input.value = '';
      window.showAlert(
        paramSuccessCount > 0
          ? t('alerts.tests_imported_with_params', 'Successfully imported {count} tests and {paramCount} parameter(s)!', {
              count: successCount,
              paramCount: paramSuccessCount,
            })
          : t('alerts.tests_imported', 'Successfully imported {count} tests!', { count: successCount }),
        'success'
      );
      await onImported();
    } catch (err) {
      console.error('Excel Parsing Error:', err);
      window.showAlert(t('alerts.excel_parse_failed_format', "Failed to parse the Excel file. Make sure it's a valid .xlsx or .csv"), 'error');
    }
  };

  reader.readAsArrayBuffer(file);
}
