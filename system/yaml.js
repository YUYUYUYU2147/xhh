import fs from 'fs';
import YAML from 'yaml';

class yaml {
  get(path) {
    let read;
    try {
      read = fs.readFileSync(path, 'utf-8');
    } catch (err) {
      logger.error(err);
      return false;
    }
    return YAML.parse(read);
  }

  /**
   * 在原文件上补键（只增不删），保留注释和排版。
   *
   * ⚠ 千万别用 YAML.parse + YAML.stringify 整份重写：那样会把用户配置文件里
   * 所有的注释、缩进风格、行尾注释全部抹掉（实测 config.yaml 84 行注释、
   * 266 行会变成 148 行纯数据）。这里必须用 parseDocument —— 它保留 comment
   * 和 format，toString() 出来只比原文多出新增的那几个键。
   *
   * @param {string} path 配置文件路径
   * @param {string[]} keyPaths 要补的键路径数组，如 ['bbb'] / ['groups','nte']
   * @param {Function} getValue 由 keyPath 取出要写入的值
   * @returns {boolean} 是否真的写了东西
   */
  setMissing(path, keyPaths, getValue) {
    if (!Array.isArray(keyPaths) || !keyPaths.length) return false;
    let read;
    try {
      read = fs.readFileSync(path, 'utf-8');
    } catch (err) {
      logger.error(err);
      return false;
    }
    try {
      const doc = YAML.parseDocument(read);
      for (const keyPath of keyPaths) {
        // keyPath 用 \0 分隔，避免键名本身带 '.' 时被 setIn 拆成嵌套路径
        const parts = keyPath.split('\0');
        if (doc.hasIn(parts)) continue;
        doc.setIn(parts, getValue(keyPath));
      }
      const out = doc.toString();
      // 内容没变就不写盘，避免无谓的 mtime 变动
      if (out === read) return false;
      fs.writeFileSync(path, out, 'utf-8');
      return true;
    } catch (err) {
      logger.error(err);
      return false;
    }
  }

  set(path, keyname, value) {
    let read;
    try {
      read = fs.readFileSync(path, 'utf-8');
    } catch (err) {
      logger.error(err);
      return false;
    }
    let D = YAML.parseDocument(read);
    try {
      D.setIn(keyname.split('.'), value);
      fs.writeFileSync(path, YAML.stringify(D), 'utf-8');
    } catch (err) {
      logger.error(err);
      return false;
    }
  }

  add(path, keyname, value) {
    let du;
    try {
      du = fs.readFileSync(path, 'utf-8');
    } catch (err) {
      logger.error(err);
      return false;
    }
    let dd = YAML.parse(du);
    //避免手改yaml时，忘加[]
    if (!Array.isArray(dd[keyname])) {
      let arr = [];
      arr.push(dd[keyname]);
      dd[keyname] = arr;
      du = YAML.stringify(dd);
    }
    let D = YAML.parseDocument(du);
    try {
      D.addIn(keyname.split('.'), value);
      fs.writeFileSync(path, YAML.stringify(D), 'utf-8');
    } catch (err) {
      logger.error(err);
      return false;
    }
  }

  del(path, keyname, value) {
    let read;
    try {
      read = fs.readFileSync(path, 'utf-8');
    } catch (err) {
      logger.error(err);
      return false;
    }
    let D = YAML.parse(read);
    try {
      //非[]，清掉后成空[]
      if (!Array.isArray(D[keyname])) {
        let arr = [];
        arr.push(D[keyname]);
        D[keyname] = arr;
      }
      if (D[keyname].indexOf(value) !== -1) {
        D[keyname].splice(D[keyname].indexOf(value), 1);
        logger.info('del is ok');
        this.set(path, keyname, D[keyname]);
      }
    } catch (err) {
      logger.error(err);
      return false;
    }
  }
}

export default new yaml();
