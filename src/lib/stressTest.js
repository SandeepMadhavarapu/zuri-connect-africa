/**
 * Stress test utilities for development mode
 * Simulates edge cases: offline, corrupted storage, missing auth, etc.
 */

const STRESS_TESTS = {
  // Auth scenarios
  noAuth: () => {
    localStorage.removeItem('auth_token');
    sessionStorage.clear();
  },
  
  // Storage corruption
  corruptedStorage: () => {
    try {
      localStorage.setItem('budgetLimits', 'INVALID_JSON{{{');
      localStorage.setItem('ledger_entries', 'corrupted data');
      sessionStorage.setItem('_test', 'bad');
    } catch (e) {
      console.warn('Storage corruption test:', e);
    }
  },
  
  // Network simulation
  offline: () => {
    Object.defineProperty(navigator, 'onLine', {
      writable: true,
      value: false,
    });
  },
  
  online: () => {
    Object.defineProperty(navigator, 'onLine', {
      writable: true,
      value: true,
    });
  },
  
  // Empty data scenarios
  emptyLedger: () => {
    localStorage.setItem('ledger_entries', JSON.stringify([]));
  },
  
  emptyTransactions: () => {
    sessionStorage.setItem('transactions', JSON.stringify([]));
  },
  
  // Null/undefined scenarios
  nullBudget: () => {
    localStorage.setItem('budgetLimits', 'null');
  },
  
  // Large data test
  largeLedger: () => {
    const entries = Array.from({ length: 10000 }, (_, i) => ({
      id: i,
      amount: Math.random() * 10000,
      date: new Date().toISOString(),
    }));
    localStorage.setItem('ledger_entries', JSON.stringify(entries));
  },
};

export function runStressTest(testName) {
  if (import.meta.env.MODE !== 'development') {
    console.warn('[StressTest] Only available in development');
    return;
  }
  
  const test = STRESS_TESTS[testName];
  if (!test) {
    console.warn(`[StressTest] Unknown test: ${testName}`);
    return;
  }
  
  try {
    test();
    console.log(`[StressTest] ✓ "${testName}" executed`);
  } catch (e) {
    console.error(`[StressTest] "${testName}" failed:`, e);
  }
}

export function runAllStressTests() {
  if (import.meta.env.MODE !== 'development') return;
  
  console.group('[StressTest] Running all tests...');
  Object.keys(STRESS_TESTS).forEach(name => {
    try {
      STRESS_TESTS[name]();
      console.log(`✓ ${name}`);
    } catch (e) {
      console.warn(`✗ ${name}:`, e.message);
    }
  });
  console.groupEnd();
}

// Expose to window for manual testing
if (import.meta.env.MODE === 'development') {
  window.__stressTest = {
    run: runStressTest,
    runAll: runAllStressTests,
    tests: Object.keys(STRESS_TESTS),
  };
}