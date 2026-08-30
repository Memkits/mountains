'use client';

import {
  CircleGauge,
  Compass,
  Gamepad2,
  Layers3,
  MapPin,
  Mountain,
  RotateCcw,
} from 'lucide-react';
import { useMemo, useState } from 'react';

import { TerrainView, type TerrainStats } from '@/components/terrain-view';
import { Button } from '@/components/ui/button';
import { Slider } from '@/components/ui/slider';
import { Switch } from '@/components/ui/switch';

const PORT = {
  name: '吉隆口岸',
  subtitle: 'Gyirong · Rasuwagadhi',
  latitude: 28.27972,
  longitude: 85.37778,
};

const initialStats: TerrainStats = {
  fps: 0,
  triangles: 0,
  loadedTiles: 0,
  totalTiles: 9,
  gamepad: null,
  renderer: 'INITIALIZING',
};

export default function Home() {
  const [exaggeration, setExaggeration] = useState(1.45);
  const [wireframe, setWireframe] = useState(false);
  const [highDetail, setHighDetail] = useState(true);
  const [resetSignal, setResetSignal] = useState(0);
  const [stats, setStats] = useState<TerrainStats>(initialStats);

  const triangles = useMemo(
    () =>
      stats.triangles > 1000
        ? `${Math.round(stats.triangles / 1000)}K`
        : `${stats.triangles}`,
    [stats.triangles],
  );

  return (
    <main className="terrain-shell">
      <TerrainView
        center={PORT}
        exaggeration={exaggeration}
        highDetail={highDetail}
        resetSignal={resetSignal}
        wireframe={wireframe}
        onStats={setStats}
      />

      <header className="topbar">
        <div className="brand-lockup">
          <span className="brand-mark" aria-hidden="true">
            <Mountain />
          </span>
          <div>
            <p>HIMALAYA / 3D TERRAIN LAB</p>
            <span>喜马拉雅地形实验室</span>
          </div>
        </div>

        <div className="location-chip">
          <MapPin aria-hidden="true" />
          <div>
            <strong>{PORT.name}</strong>
            <span>{PORT.subtitle}</span>
          </div>
        </div>

        <div className="engine-status" aria-label={`Renderer ${stats.renderer}`}>
          <span className={stats.renderer === 'WEBGPU' ? 'is-live' : ''} />
          {stats.renderer}
        </div>
      </header>

      <section className="place-card glass-panel" aria-label="Location details">
        <p className="eyebrow">当前观测点</p>
        <div className="place-title">
          <div>
            <h1>{PORT.name}</h1>
            <p>{PORT.subtitle}</p>
          </div>
          <Compass aria-hidden="true" />
        </div>
        <div className="coordinate-grid">
          <div>
            <span>LATITUDE</span>
            <strong>{PORT.latitude.toFixed(5)}° N</strong>
          </div>
          <div>
            <span>LONGITUDE</span>
            <strong>{PORT.longitude.toFixed(5)}° E</strong>
          </div>
        </div>
        <div className="terrain-note">
          <span className="terrain-note-line" />
          <p>
            中尼边境峡谷
            <small>高程基准约 1,850 m</small>
          </p>
          <b>PORT / 01</b>
        </div>
      </section>

      <aside className="control-panel glass-panel" aria-label="Terrain controls">
        <div className="panel-heading">
          <div>
            <p className="eyebrow">TERRAIN CONTROLS</p>
            <h2>地形显示</h2>
          </div>
          <Layers3 aria-hidden="true" />
        </div>

        <div className="control-block">
          <div className="control-label">
            <span>垂直夸张</span>
            <output>{exaggeration.toFixed(2)}×</output>
          </div>
          <Slider
            aria-label="Vertical exaggeration"
            min={0.65}
            max={2.4}
            step={0.05}
            value={[exaggeration]}
            onValueChange={(value) =>
              setExaggeration(
                (Array.isArray(value) ? value[0] : value) ?? 1.45,
              )
            }
          />
          <div className="range-labels">
            <span>0.65×</span>
            <span>2.40×</span>
          </div>
        </div>

        <div className="toggle-row">
          <div>
            <strong>高精细网格</strong>
            <span>{highDetail ? '128 格 / 瓦片' : '64 格 / 瓦片'}</span>
          </div>
          <Switch
            aria-label="High detail terrain"
            checked={highDetail}
            onCheckedChange={setHighDetail}
          />
        </div>

        <div className="toggle-row">
          <div>
            <strong>网格模式</strong>
            <span>检查地形三角面</span>
          </div>
          <Switch
            aria-label="Terrain wireframe"
            checked={wireframe}
            onCheckedChange={setWireframe}
          />
        </div>

        <Button
          variant="outline"
          size="lg"
          className="reset-button"
          onClick={() => setResetSignal((value) => value + 1)}
        >
          <RotateCcw data-icon="inline-start" />
          重置视角
        </Button>
      </aside>

      <section className="gamepad-card glass-panel" aria-label="Gamepad controls">
        <div className="gamepad-title">
          <Gamepad2 aria-hidden="true" />
          <div>
            <span>{stats.gamepad ? '手柄已连接' : '手柄控制'}</span>
            <small>{stats.gamepad ?? '按任意键激活'}</small>
          </div>
        </div>
        <div className="gamepad-map">
          <span><i>LS</i>平移</span>
          <span><i>RS</i>环视</span>
          <span><i>LT / RT</i>升降</span>
          <span><i>LB / RB</i>加速</span>
        </div>
      </section>

      <section className="telemetry" aria-label="Rendering telemetry">
        <div>
          <span>FPS</span>
          <strong>{stats.fps || '—'}</strong>
        </div>
        <div>
          <span>TRIANGLES</span>
          <strong>{triangles}</strong>
        </div>
        <div>
          <span>TILES</span>
          <strong>{stats.loadedTiles}/{stats.totalTiles}</strong>
        </div>
        <div>
          <CircleGauge aria-hidden="true" />
          <span>{highDetail ? 'HIGH' : 'BALANCED'}</span>
        </div>
      </section>

      <div className="crosshair" aria-hidden="true">
        <span />
        <i />
      </div>

      <p className="attribution">
        DEM · Mapzen Terrain Tiles on AWS / SRTM · ETOPO1
      </p>

      <div className="input-hint">
        <span><kbd>DRAG</kbd> 环视</span>
        <span><kbd>W A S D</kbd> 移动</span>
        <span><kbd>SCROLL</kbd> 缩放</span>
      </div>
    </main>
  );
}
