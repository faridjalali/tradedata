import type { BreadthMetric } from '../store/breadthStore';

interface BreadthViewProps {
  onSelectTimeframe: (days: number) => void;
  onSelectMetric: (metric: BreadthMetric) => void;
  onSelectCompareTf: (days: number) => void;
  onToggleCompareMode: () => void;
  onSelectBarsMA: (ma: string) => void;
}

export function BreadthView({
  onSelectTimeframe,
  onSelectMetric,
  onSelectCompareTf,
  onToggleCompareMode,
  onSelectBarsMA,
}: BreadthViewProps) {
  return (
    <div class="single-page-container breadth-page">
      <div class="single-page-header">
        <div class="single-page-controls breadth-primary-controls">
          <div id="breadth-tf-btns" class="feed-controls-group">
            <button class="pane-btn" data-days="1" type="button" onClick={() => onSelectTimeframe(1)}>
              1
            </button>
            <button class="pane-btn active" data-days="5" type="button" onClick={() => onSelectTimeframe(5)}>
              5
            </button>
            <button class="pane-btn" data-days="10" type="button" onClick={() => onSelectTimeframe(10)}>
              10
            </button>
            <button class="pane-btn" data-days="20" type="button" onClick={() => onSelectTimeframe(20)}>
              20
            </button>
            <button class="pane-btn" data-days="30" type="button" onClick={() => onSelectTimeframe(30)}>
              30
            </button>
          </div>
          <div id="breadth-metric-btns" class="feed-controls-group">
            <button class="pane-btn active" data-metric="SVIX" type="button" onClick={() => onSelectMetric('SVIX')}>
              SPY / SVIX
            </button>
            <button class="pane-btn" data-metric="RSP" type="button" onClick={() => onSelectMetric('RSP')}>
              SPY / RSP
            </button>
            <button class="pane-btn" data-metric="MAGS" type="button" onClick={() => onSelectMetric('MAGS')}>
              SPY / MAGS
            </button>
          </div>
        </div>
      </div>
      <div class="single-page-chart-wrapper">
        <canvas id="breadth-chart"></canvas>
      </div>
      <div id="breadth-error" class="single-page-status hidden-init"></div>

      <div class="breadth-ma-section">
        <div class="single-page-header">
          <div class="single-page-controls">
            <div id="breadth-ma-index-btns" class="feed-controls-group feed-controls-group--wrap"></div>
          </div>
        </div>
        <div id="breadth-ma-gauges" class="breadth-gauges-row"></div>
        <div class="single-page-chart-wrapper">
          <canvas id="breadth-ma-chart"></canvas>
        </div>
        <div id="breadth-ma-error" class="single-page-status hidden-init"></div>
      </div>

      <div class="breadth-compare-section">
        <div class="single-page-header">
          <div class="single-page-controls">
            <div id="breadth-compare-index-btns" class="feed-controls-group feed-controls-group--wrap">
              <button
                id="breadth-compare-toggle"
                class="pane-btn breadth-compare-toggle-btn"
                type="button"
                onClick={() => onToggleCompareMode()}
              >
                Compare
              </button>
            </div>
            <div class="breadth-compare-timeframe-row">
              <div id="breadth-compare-tf-btns" class="feed-controls-group">
                <button class="pane-btn" data-days="5" type="button" onClick={() => onSelectCompareTf(5)}>
                  5
                </button>
                <button class="pane-btn" data-days="10" type="button" onClick={() => onSelectCompareTf(10)}>
                  10
                </button>
                <button class="pane-btn active" data-days="20" type="button" onClick={() => onSelectCompareTf(20)}>
                  20
                </button>
                <button class="pane-btn" data-days="30" type="button" onClick={() => onSelectCompareTf(30)}>
                  30
                </button>
              </div>
            </div>
          </div>
        </div>
        <div id="breadth-compare-gauges" style="display: none"></div>
        <div class="single-page-chart-wrapper">
          <canvas id="breadth-compare-chart"></canvas>
        </div>
        <div id="breadth-compare-error" class="single-page-status hidden-init"></div>
      </div>

      <div class="breadth-bars-section">
        <div class="single-page-header">
          <div class="single-page-controls">
            <div id="breadth-bars-ma-btns" class="feed-controls-group">
              <button class="pane-btn active" data-ma="21" type="button" onClick={() => onSelectBarsMA('21')}>
                21 MA
              </button>
              <button class="pane-btn" data-ma="50" type="button" onClick={() => onSelectBarsMA('50')}>
                50 MA
              </button>
              <button class="pane-btn" data-ma="100" type="button" onClick={() => onSelectBarsMA('100')}>
                100 MA
              </button>
              <button class="pane-btn" data-ma="200" type="button" onClick={() => onSelectBarsMA('200')}>
                200 MA
              </button>
            </div>
          </div>
        </div>
        <div class="single-page-chart-wrapper breadth-bars-chart-wrapper">
          <canvas id="breadth-bars-chart"></canvas>
        </div>
        <div id="breadth-bars-error" class="single-page-status hidden-init"></div>
      </div>
    </div>
  );
}
