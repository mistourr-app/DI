import { computeGameArea, GAME_RATIO } from './layout';

describe('computeGameArea', () => {
  it('широкий экран: поле по высоте, ширина кратна 16, центрировано по X', () => {
    const area = computeGameArea(1920, 1080);

    expect(area.height).toBe(1080);
    expect(area.width % 16).toBe(0);
    expect(area.width).toBe(512);
    expect(area.y).toBe(0);
    expect(area.x).toBe(704);
    // Центрирование: равные поля слева и справа
    expect(area.x * 2 + area.width).toBe(1920);
  });

  it('узкий экран: поле по ширине, центрировано по Y (допустим небольшой сдвиг округления)', () => {
    const area = computeGameArea(800, 1920);

    expect(area.width).toBe(800);
    expect(area.x).toBe(0);
    expect(area.height).toBe(Math.round(800 / GAME_RATIO));
    expect(Math.abs(area.y - (1920 - area.height) / 2)).toBeLessThanOrEqual(1);
  });

  it('на точном соотношении поле заполняет экран без полей', () => {
    // 900 / 1950 == 9 / 19.5 == GAME_RATIO
    const area = computeGameArea(900, 1950);

    expect(area.x).toBe(0);
    expect(area.y).toBe(0);
    expect(area.width).toBe(900);
    expect(area.height).toBe(1950);
  });

  it('ширина игрового поля всегда кратна 16 и покрывает пропорцию с запасом < 16px', () => {
    for (let height = 400; height <= 3000; height += 37) {
      const width = height + 500; // заведомо шире пропорции
      const area = computeGameArea(width, height);

      expect(area.height).toBe(height);
      expect(area.width % 16).toBe(0);
      const ideal = height * GAME_RATIO;
      expect(area.width).toBeGreaterThanOrEqual(ideal);
      expect(area.width - ideal).toBeLessThan(16);
    }
  });

  it('не мутирует входные данные и возвращает примитивные поля', () => {
    const area = computeGameArea(1000, 2000);

    expect(Object.keys(area).sort()).toEqual(['height', 'width', 'x', 'y']);
    expect(Number.isFinite(area.x)).toBe(true);
    expect(Number.isFinite(area.y)).toBe(true);
  });
});
