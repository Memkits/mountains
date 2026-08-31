'use client';

import {
  CircleGauge,
  Compass,
  Gamepad2,
  Layers3,
  MapPinned,
  MapPin,
  Maximize2,
  Mountain,
  RotateCcw,
} from 'lucide-react';
import { useMemo, useRef, useState } from 'react';

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
  loadedMapTiles: 0,
  mapProvider: 'NONE',
  totalTiles: 49,
  gamepad: null,
  gamepadMode: null,
  gamepadDebug: null,
  renderer: 'INITIALIZING',
};

export default function Home() {
  const shellRef = useRef<HTMLElement>(null);
  const [exaggeration, setExaggeration] = useState(1);
  const [wireframe, setWireframe] = useState(false);
  const [mapOverlay, setMapOverlay] = useState(true);
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

  const toggleFullscreen = async () => {
    try {
      if (document.fullscreenElement) {
        await document.exitFullscreen();
        console.info('[fullscreen] exited');
      } else if (shellRef.current) {
        await shellRef.current.requestFullscreen();
        console.info('[fullscreen] entered; press Escape to exit');
      }
    } catch (error) {
      console.warn('[fullscreen] request failed', error);
    }
  };

  return (
    <main ref={shellRef} className="terrain-shell">
      <TerrainView
        center={PORT}
        exaggeration={exaggeration}
        highDetail={highDetail}
        mapOverlay={mapOverlay}
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

        <div className="topbar-actions">
          <button
            type="button"
            className="fullscreen-button"
            aria-label="进入全屏模式，按 Escape 退出"
            title="全屏模式（Esc 退出）"
            onClick={() => void toggleFullscreen()}
          >
            <Maximize2 aria-hidden="true" />
            <span>全屏</span>
          </button>
          <div
            className="engine-status"
            aria-label={`Renderer ${stats.renderer}`}
          >
            <span className={stats.renderer === 'WEBGPU' ? 'is-live' : ''} />
            {stats.renderer}
          </div>
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
            2026-08-26 灾害通道
            <small>红：岩冰崩塌源区 · 青：山洪河谷</small>
            <small>
              金：中尼国界 · 橙：中印国界 · 蓝：水系 · 紫：川藏—吉隆路线
            </small>
          </p>
          <b>EVENT / 01</b>
        </div>
      </section>

      <aside
        className="control-panel glass-panel"
        aria-label="Terrain controls"
      >
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
              setExaggeration((Array.isArray(value) ? value[0] : value) ?? 1.45)
            }
          />
          <div className="range-labels">
            <span>0.65×</span>
            <span>2.40×</span>
          </div>
        </div>

        <div className="toggle-row">
          <div>
            <strong>地图数据层</strong>
            <span>
              {stats.mapProvider === 'GOOGLE'
                ? 'Google Satellite · 自适应 Z14 → Z11 · 地平线 Z9'
                : 'OpenTopoMap · 道路 / 地名 / 等高线'}
            </span>
          </div>
          <Switch
            aria-label="Topographic map overlay"
            checked={mapOverlay}
            onCheckedChange={setMapOverlay}
          />
        </div>

        <div className="toggle-row">
          <div>
            <strong>高精细网格</strong>
            <span>
              {highDetail
                ? '屏幕自适应 255 / 95 / 31 / 15 格'
                : '屏幕自适应 127 / 63 / 31 / 15 格'}
            </span>
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

      <section
        className="gamepad-card glass-panel"
        aria-label="Gamepad controls"
      >
        <div className="gamepad-title">
          <Gamepad2 aria-hidden="true" />
          <div>
            <span>{stats.gamepad ? '手柄已连接' : '手柄控制'}</span>
            <small>
              {stats.gamepad
                ? `${stats.gamepad} · ${stats.gamepadMode ?? 'DEFAULT'}`
                : '点击地形画面，然后按任意键激活'}
            </small>
          </div>
        </div>
        <div className="gamepad-map">
          <span>
            <i>LS</i>镜头前后 / 转向
          </span>
          <span>
            <i>RS</i>镜头横移 / 纵移
          </span>
          <span>
            <i>L2 / R2</i>缩放
          </span>
          <span>
            <i>L1 / R1</i>移动 16/256× · 旋转 2/4×
          </span>
          <span>
            <i>D-PAD</i>俯仰 / 滚转
          </span>
          <span>
            <i>L3 / R3</i>朝北 / 回到口岸
          </span>
          <span>
            <i>□</i>扫描视野地名
          </span>
          <span>
            <i>○</i>隐藏 / 恢复标记
          </span>
        </div>
        <output className="gamepad-debug">
          {stats.gamepadDebug ?? '等待 Chrome Gamepad API 输入…'}
        </output>
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
          <span>DEM TILES</span>
          <strong>
            {stats.loadedTiles}/{stats.totalTiles}
          </strong>
        </div>
        <div>
          <span>MAP TILES</span>
          <strong>
            {stats.loadedMapTiles}/{stats.totalTiles}
          </strong>
        </div>
        <div>
          {mapOverlay ? (
            <MapPinned aria-hidden="true" />
          ) : (
            <CircleGauge aria-hidden="true" />
          )}
          <span>
            {mapOverlay
              ? stats.mapProvider === 'GOOGLE'
                ? 'GOOGLE MAP'
                : 'TOPO MAP'
              : highDetail
                ? 'HIGH'
                : 'BALANCED'}
          </span>
        </div>
      </section>

      <div className="crosshair" aria-hidden="true">
        <span />
        <i />
      </div>

      <p className="attribution">
        DEM · Mapzen Terrain Tiles / SRTM ·{' '}
        {stats.mapProvider === 'GOOGLE' ? (
          <>Map data © Google</>
        ) : (
          <>
            Map data ©{' '}
            <a
              href="https://www.openstreetmap.org/copyright"
              target="_blank"
              rel="noreferrer"
            >
              OpenStreetMap contributors
            </a>{' '}
            · Style ©{' '}
            <a href="https://opentopomap.org" target="_blank" rel="noreferrer">
              OpenTopoMap
            </a>
          </>
        )}
      </p>

      <div className="input-hint">
        <span>
          <kbd>DRAG</kbd> 环视
        </span>
        <span>
          <kbd>W A S D</kbd> 移动
        </span>
        <span>
          <kbd>SCROLL</kbd> 缩放
        </span>
      </div>
    </main>
  );
}
