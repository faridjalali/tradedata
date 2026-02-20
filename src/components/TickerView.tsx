import { useEffect, useState } from 'preact/hooks';
import { appStore } from '../store/appStore';
import { renderTickerView, setTickerDailySort, setTickerWeeklySort } from '../ticker';

function useSelectedTicker(): string | null {
  const [selectedTicker, setSelectedTicker] = useState<string | null>(appStore.getState().selectedTicker);

  useEffect(() => {
    return appStore.subscribe((state, prevState) => {
      if (state.selectedTicker !== prevState.selectedTicker) {
        setSelectedTicker(state.selectedTicker);
      }
    });
  }, []);

  return selectedTicker;
}

export function TickerView() {
  const selectedTicker = useSelectedTicker();

  useEffect(() => {
    if (!selectedTicker) return;
    renderTickerView(selectedTicker);
  }, [selectedTicker]);

  return (
    <div id="ticker-view" class="hidden">
      <div class="ticker-history-section">
        <div class="split-view">
          <div class="column">
            <div class="column-header">
              <div class="header-title-group">
                <h2>Daily</h2>
                <div class="column-tf-controls" data-column="daily">
                  <button class="pane-btn active" data-tf="1" title="Last fetch day" type="button">
                    1
                  </button>
                  <button class="pane-btn" data-tf="5" title="Last 5 fetch days" type="button">
                    5
                  </button>
                  <button class="pane-btn" data-tf="30" title="Last 30 fetch days" type="button">
                    30
                  </button>
                  <button class="pane-btn" data-tf="custom" title="Custom date range" type="button">
                    C
                  </button>
                  <div class="column-tf-custom-panel header-dropdown-panel hidden">
                    <input type="date" class="glass-input column-tf-from" />
                    <span class="column-tf-sep">to</span>
                    <input type="date" class="glass-input column-tf-to" />
                    <button class="pane-btn column-tf-apply" type="button">
                      &#x203A;
                    </button>
                  </div>
                </div>
              </div>
              <div class="header-sort-controls ticker-daily-sort">
                <button
                  class="pane-btn"
                  data-sort="favorite"
                  title="Favorites only"
                  type="button"
                  onClick={() => setTickerDailySort('favorite')}
                >
                  <svg
                    width="13"
                    height="13"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
                  </svg>
                </button>
                <button class="pane-btn" data-sort="time" title="Sort by Date" type="button" onClick={() => setTickerDailySort('time')}>
                  D
                </button>
                <button
                  class="pane-btn"
                  data-sort="volume"
                  title="Sort by Volume"
                  type="button"
                  onClick={() => setTickerDailySort('volume')}
                >
                  V
                </button>
                <button
                  class="pane-btn active"
                  data-sort="score"
                  title="Sort by Score"
                  type="button"
                  onClick={() => setTickerDailySort('score')}
                >
                  S
                </button>
              </div>
            </div>
            <div id="ticker-daily-container" class="alerts-list">
              <div class="loading">Loading...</div>
            </div>
          </div>

          <div class="column">
            <div class="column-header">
              <div class="header-title-group">
                <h2>Weekly</h2>
                <div class="column-tf-controls" data-column="weekly">
                  <button class="pane-btn active" data-tf="1" title="Last fetch day" type="button">
                    1
                  </button>
                  <button class="pane-btn" data-tf="5" title="Last 5 fetch days" type="button">
                    5
                  </button>
                  <button class="pane-btn" data-tf="30" title="Last 30 fetch days" type="button">
                    30
                  </button>
                  <button class="pane-btn" data-tf="custom" title="Custom date range" type="button">
                    C
                  </button>
                  <div class="column-tf-custom-panel header-dropdown-panel hidden">
                    <input type="date" class="glass-input column-tf-from" />
                    <span class="column-tf-sep">to</span>
                    <input type="date" class="glass-input column-tf-to" />
                    <button class="pane-btn column-tf-apply" type="button">
                      &#x203A;
                    </button>
                  </div>
                </div>
              </div>
              <div class="header-sort-controls ticker-weekly-sort">
                <button
                  class="pane-btn"
                  data-sort="favorite"
                  title="Favorites only"
                  type="button"
                  onClick={() => setTickerWeeklySort('favorite')}
                >
                  <svg
                    width="13"
                    height="13"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
                  </svg>
                </button>
                <button class="pane-btn" data-sort="time" title="Sort by Date" type="button" onClick={() => setTickerWeeklySort('time')}>
                  D
                </button>
                <button
                  class="pane-btn"
                  data-sort="volume"
                  title="Sort by Volume"
                  type="button"
                  onClick={() => setTickerWeeklySort('volume')}
                >
                  V
                </button>
                <button
                  class="pane-btn active"
                  data-sort="score"
                  title="Sort by Score"
                  type="button"
                  onClick={() => setTickerWeeklySort('score')}
                >
                  S
                </button>
              </div>
            </div>
            <div id="ticker-weekly-container" class="alerts-list">
              <div class="loading">Loading...</div>
            </div>
          </div>
        </div>

        <div id="custom-chart-container" class="custom-chart-section">
          <div id="chart-controls" class="chart-controls-bar">
            <div class="feed-controls-group">
              <button class="pane-btn hidden-init" data-interval="5min" type="button">
                5
              </button>
              <button class="pane-btn" data-interval="15min" type="button">
                15
              </button>
              <button class="pane-btn" data-interval="30min" type="button">
                30
              </button>
              <button class="pane-btn" data-interval="1hour" type="button">
                1h
              </button>
              <button class="pane-btn" data-interval="4hour" type="button">
                4h
              </button>
              <button class="pane-btn active" data-interval="1day" type="button">
                1D
              </button>
              <button class="pane-btn" data-interval="1week" type="button">
                1W
              </button>
            </div>
            <div class="chart-navigation-group">
              <button id="chart-refresh-btn" class="pane-btn refresh-btn" type="button" title="Refresh Chart"></button>
              <button id="chart-nav-prev" class="pane-btn" title="Previous Ticker" type="button">
                <svg
                  width="13"
                  height="13"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <polyline points="18 15 12 9 6 15"></polyline>
                </svg>
              </button>
              <button id="chart-nav-next" class="pane-btn" title="Next Ticker" type="button">
                <svg
                  width="13"
                  height="13"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <polyline points="6 9 12 15 18 9"></polyline>
                </svg>
              </button>
            </div>
            <button id="chart-fullscreen-btn" class="pane-btn" type="button" title="Fullscreen">
              <svg
                width="13"
                height="13"
                viewBox="0 0 16 16"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <polyline points="5.5 1 1 1 1 5.5" />
                <polyline points="10.5 1 15 1 15 5.5" />
                <polyline points="10.5 15 15 15 15 10.5" />
                <polyline points="5.5 15 1 15 1 10.5" />
              </svg>
            </button>
            <button id="ticker-back-btn" class="pane-btn" type="button" title="Back">
              <svg
                width="13"
                height="13"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <line x1="19" y1="12" x2="5" y2="12"></line>
                <polyline points="12 19 5 12 12 5"></polyline>
              </svg>
            </button>
          </div>

          <div id="chart-error" class="chart-error" style="display: none"></div>

          <div id="chart-content">
            <div id="vd-chart-container" class="chart-container"></div>
            <div id="price-chart-container" class="chart-container"></div>
            <div id="rsi-chart-container" class="chart-container"></div>
            <div id="vd-rsi-chart-container" class="chart-container"></div>
          </div>
        </div>
      </div>
    </div>
  );
}
