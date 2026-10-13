import biqugen from './biqugen.mjs';
import { makeBiqugeSite } from './bqg10.mjs';
import { config } from '../config.mjs';

/**
 * 多书源注册表。
 *
 * 每个源实现统一适配器接口：
 *   listBooks({category,page}) / search(keyword) /
 *   bookDetail(sourceId) / chapterListPage(sourceId,page) / chapterContent(sourceId,ref)
 *
 * 新增镜像站时，只要模板一致，直接再 makeBiqugeSite({id,name,base}) 注册即可。
 */
export const sources = {
  [biqugen.id]: biqugen,
  bqg10: makeBiqugeSite({ id: 'bqg10', name: '笔趣书阁', base: 'https://www.bqg10.cc' }),
};

/** 默认抓取源（用于首页/榜单等无源上下文场景） */
export const DEFAULT_SOURCE = biqugen.id;

export function getSource(id = config.activeSource) {
  return sources[id] || sources[DEFAULT_SOURCE] || biqugen;
}

export function sourceList() {
  return Object.values(sources).map((s) => ({ id: s.id, name: s.name, base: s.base }));
}

export { biqugen };
