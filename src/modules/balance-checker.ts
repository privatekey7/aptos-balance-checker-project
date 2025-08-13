import { Aptos, AptosConfig, Network, Account, Ed25519PrivateKey, PrivateKey } from "@aptos-labs/ts-sdk";
import * as fs from 'fs';
import * as path from 'path';
import chalk from 'chalk';

// Конфигурация сети Aptos
const config = new AptosConfig({ network: Network.MAINNET });
const aptos = new Aptos(config);

// Кэш для цены APT
interface PriceCache {
  price: number;
  timestamp: number;
}

let aptPriceCache: PriceCache | null = null;
const CACHE_DURATION = 5 * 60 * 1000; // 5 минут в миллисекундах

/**
 * Получает актуальную цену APT в долларах через Binance API
 * @returns Цена APT в долларах
 */
async function getAptPrice(): Promise<number> {
  try {
    // Проверяем кэш
    if (aptPriceCache && (Date.now() - aptPriceCache.timestamp) < CACHE_DURATION) {
      return aptPriceCache.price;
    }

    // Получаем цену через Binance API
    const response = await fetch('https://api.binance.com/api/v3/ticker/price?symbol=APTUSDT');
    
    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }
    
    const data = await response.json() as { price: string };
    const price = parseFloat(data.price);
    
    // Обновляем кэш
    aptPriceCache = {
      price,
      timestamp: Date.now()
    };
    
    return price;
    
  } catch (error) {
    console.error(chalk.red('❌ Ошибка при получении цены APT:'), error);
    
    // Возвращаем кэшированную цену если есть, иначе 0
    return aptPriceCache?.price || 0;
  }
}

/**
 * Читает адреса кошельков из файла wallets.txt
 * @returns Массив адресов кошельков
 */
function readWalletAddresses(): string[] {
  try {
    const filePath = path.join(__dirname, '..', '..', 'wallets.txt');
    const content = fs.readFileSync(filePath, 'utf8');
    
    // Разбиваем по строкам и фильтруем пустые строки и комментарии
    const addresses = content
      .split('\n')
      .map(line => line.trim())
      .filter(line => line.length > 0 && !line.startsWith('#'))
      .filter(line => line.startsWith('0x')); // Проверяем, что это валидный адрес
    
    return addresses;
    
  } catch (error) {
    console.error(chalk.red('❌ Ошибка при чтении файла wallets.txt:'), error);
    return [];
  }
}

/**
 * Читает приватные ключи из файла keys.txt (для модуля трансфера)
 * @returns Массив приватных ключей
 */
function readPrivateKeys(): string[] {
  try {
    const filePath = path.join(__dirname, '..', '..', 'keys.txt');
    const content = fs.readFileSync(filePath, 'utf8');
    
    // Разбиваем по строкам и фильтруем пустые строки
    const keys = content
      .split('\n')
      .map(line => line.trim())
      .filter(line => line.length > 0);
    
    return keys;
    
  } catch (error) {
    console.error(chalk.red('❌ Ошибка при чтении файла keys.txt:'), error);
    return [];
  }
}

/**
 * Генерирует адрес из приватного ключа (для модуля трансфера)
 * @param privateKeyHex - Приватный ключ в hex формате
 * @returns Адрес кошелька
 */
async function generateAddressFromPrivateKey(privateKeyHex: string): Promise<string> {
  try {
    // Форматируем приватный ключ по стандарту AIP-80
    const formattedKey = PrivateKey.formatPrivateKey(privateKeyHex, 'ed25519' as any);
    
    // Создаем приватный ключ
    const privateKey = new Ed25519PrivateKey(formattedKey);
    
    // Генерируем аккаунт из приватного ключа
    const account = await Account.fromPrivateKey({ privateKey });
    
    return account.accountAddress.toString();
    
  } catch (error) {
    console.error(chalk.red(`❌ Ошибка при генерации адреса из ключа ${privateKeyHex}:`), error);
    throw error;
  }
}

/**
 * Получает баланс нативного токена APT для указанного адреса
 * @param address - Адрес кошелька в формате hex
 * @returns Объект с балансом и информацией о токене
 */
async function getAptBalance(address: string) {
  try {
    // Получаем балансы через getCurrentFungibleAssetBalances
    const balances = await aptos.getCurrentFungibleAssetBalances({ 
      options: { 
        where: { 
          owner_address: { _eq: address } 
        } 
      } 
    });
    
    // Ищем баланс APT токена
    const aptBalance = balances.find(balance => 
      balance.asset_type === "0x1::aptos_coin::AptosCoin"
    );
    
    if (!aptBalance) {
      return {
        address,
        balanceOctets: "0",
        balanceApt: 0,
        tokenType: "0x1::aptos_coin::AptosCoin"
      };
    }
    
    // Конвертируем из октетов в APT (1 APT = 100,000,000 октетов)
    const aptAmount = Number(aptBalance.amount) / 100_000_000;
    
    return {
      address,
      balanceOctets: aptBalance.amount.toString(),
      balanceApt: aptAmount,
      tokenType: "0x1::aptos_coin::AptosCoin"
    };
    
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    
    // Проверяем на rate limit ошибку
    if (errorMessage.includes('rate limit exceeded') || errorMessage.includes('429')) {
      console.error(chalk.yellow('⚠️ Превышен лимит запросов к API. Ожидание 60 секунд...'));
      await new Promise(resolve => setTimeout(resolve, 60000)); // Ждем 60 секунд
      // Пытаемся повторить запрос
      return await getAptBalance(address);
    }
    
    console.error(chalk.red('❌ Ошибка при получении баланса:'), error);
    throw error;
  }
}

/**
 * Проверяет балансы для всех кошельков из файла wallets.txt
 */
export async function checkAllWallets() {
  try {
    const addresses = readWalletAddresses();
    
    if (addresses.length === 0) {
      console.log(chalk.red("❌ Не найдено адресов кошельков в файле wallets.txt"));
      console.log(chalk.yellow("💡 Добавьте адреса кошельков в файл wallets.txt (по одному на строку)"));
      return;
    }
    
    console.log(chalk.cyan.bold(`🚀 Проверка ${addresses.length} кошельков...\n`));
    
    // Получаем цену APT один раз для всех кошельков
    const aptPrice = await getAptPrice();
    console.log(chalk.green.bold(`💰 Цена APT: $${aptPrice.toFixed(4)} USD\n`));
    
    const results: Array<{
      address: string;
      balanceOctets: string;
      balanceApt: number;
      tokenType: string;
      error?: string;
    }> = [];
    let totalApt = 0;
    
    for (let i = 0; i < addresses.length; i++) {
      const address = addresses[i];
      
      try {
        // Получаем баланс
        const result = await getAptBalance(address);
        results.push({
          address,
          balanceOctets: result.balanceOctets,
          balanceApt: result.balanceApt,
          tokenType: result.tokenType
        });
        totalApt += result.balanceApt;
        
        // Выводим адрес, баланс APT и цену в долларах с цветами
        const balanceUSD = result.balanceApt * aptPrice;
        const addressShort = address.substring(0, 8) + '...' + address.substring(address.length - 8);
        
        if (result.balanceApt > 0) {
          console.log(chalk.white(`${i + 1}. ${chalk.blue(addressShort)} - ${chalk.yellow(result.balanceApt.toFixed(8))} APT ${chalk.green(`($${balanceUSD.toFixed(2)})`)}`));
        } else {
          console.log(chalk.white(`${i + 1}. ${chalk.blue(addressShort)} - ${chalk.gray(result.balanceApt.toFixed(8))} APT ${chalk.gray(`($${balanceUSD.toFixed(2)})`)}`));
        }
        
        // Добавляем небольшую задержку между запросами
        if (i < addresses.length - 1) {
          await new Promise(resolve => setTimeout(resolve, 1000));
        }
        
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        console.error(chalk.red(`❌ Ошибка при проверке кошелька ${i + 1}:`), errorMessage);
        results.push({
          address,
          balanceOctets: "0",
          balanceApt: 0,
          tokenType: "0x1::aptos_coin::AptosCoin",
          error: errorMessage
        });
      }
    }
    
    // Выводим итоговый результат
    const totalUSD = totalApt * aptPrice;
    console.log(chalk.cyan.bold(`\n📊 Итого: ${chalk.yellow(totalApt.toFixed(8))} APT ${chalk.green(`($${totalUSD.toFixed(2)})`)}`));
    
    return { results, totalApt, totalUSD };
    
  } catch (error) {
    console.error(chalk.red("💥 Критическая ошибка:"), error);
    throw error;
  }
}

// Экспортируем вспомогательные функции для использования в других модулях
export { getAptBalance, readPrivateKeys, generateAddressFromPrivateKey, getAptPrice };
