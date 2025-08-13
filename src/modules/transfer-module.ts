import { Aptos, AptosConfig, Network, Account, Ed25519PrivateKey, PrivateKey } from "@aptos-labs/ts-sdk";
import * as fs from 'fs';
import * as path from 'path';
import chalk from 'chalk';
import { readPrivateKeys, generateAddressFromPrivateKey, getAptBalance, getAptPrice } from './balance-checker';

// Конфигурация сети Aptos
const config = new AptosConfig({ network: Network.MAINNET });
const aptos = new Aptos(config);

// Убираем кэширование для полностью динамического расчета комиссии

/**
 * Читает адреса субаккаунтов из файла sub_accs.txt
 * @returns Массив адресов субаккаунтов
 */
function readSubAccounts(): string[] {
  try {
    const filePath = path.join(__dirname, '..', '..', 'sub_accs.txt');
    const content = fs.readFileSync(filePath, 'utf8');
    
    // Разбиваем по строкам и фильтруем пустые строки
    const addresses = content
      .split('\n')
      .map(line => line.trim())
      .filter(line => line.length > 0);
    
    return addresses;
    
  } catch (error) {
    console.error(chalk.red('❌ Ошибка при чтении файла sub_accs.txt:'), error);
    return [];
  }
}

/**
 * Симулирует транзакцию для получения точных параметров газа
 * @param fromAccount - Аккаунт отправителя
 * @param toAddress - Адрес получателя
 * @param amountInOctas - Сумма в octas
 * @returns Параметры газа из симуляции
 */
async function simulateTransaction(
  fromAccount: Account,
  toAddress: string,
  amountInOctas: bigint
): Promise<{ gasUsed: number; gasUnitPrice: number; maxGasAmount: number }> {
  try {
    // Создаем транзакцию для симуляции
    const transaction = await aptos.transferCoinTransaction({
      sender: fromAccount.accountAddress,
      recipient: toAddress,
      amount: amountInOctas,
    });
    
    // Симулируем транзакцию с флагами для получения параметров газа
    const simulation = await aptos.transaction.simulate.simple({
      transaction,
      options: {
        estimateGasUnitPrice: true,
        estimateMaxGasAmount: true,
      }
    });
    
    // Получаем параметры из первого результата симуляции
    const firstResult = simulation[0];
    const gasUsed = Number(firstResult?.gas_used) || 1000; // Fallback если gas_used не определен
    const gasUnitPrice = Number(firstResult?.gas_unit_price) || 100; // Fallback если gas_unit_price не определен
    const simulatedMaxGasAmount = Number(firstResult?.max_gas_amount) || 10000; // Fallback если max_gas_amount не определен
    
    // Рассчитываем безопасный maxGasAmount с safety factor 1.1
    const safetyFactor = 1.1;
    const calculatedMaxGasAmount = Math.ceil(gasUsed * safetyFactor);
    const maxGasAmount = Math.min(simulatedMaxGasAmount, calculatedMaxGasAmount);
    
    return { gasUsed, gasUnitPrice, maxGasAmount };
    
     } catch (error) {
     const errorMessage = error instanceof Error ? error.message : String(error);
     
     // Проверяем на rate limit ошибку
     if (errorMessage.includes('rate limit exceeded') || errorMessage.includes('429')) {
       console.error(chalk.yellow('⚠️ Превышен лимит запросов к API при симуляции. Ожидание 60 секунд...'));
       await new Promise(resolve => setTimeout(resolve, 60000)); // Ждем 60 секунд
       // Пытаемся повторить симуляцию
       return await simulateTransaction(fromAccount, toAddress, amountInOctas);
     }
     
     console.error(chalk.yellow('⚠️ Ошибка симуляции, используем резервные значения'));
     return { gasUsed: 1000, gasUnitPrice: 100, maxGasAmount: 2000 };
   }
}

/**
 * Отправляет весь баланс APT с одного адреса на другой
 * @param fromPrivateKey - Приватный ключ отправителя
 * @param toAddress - Адрес получателя
 * @param balance - Текущий баланс кошелька
 * @returns Результат транзакции
 */
async function transferAllApt(fromPrivateKey: string, toAddress: string, balance: number) {
  try {
    // Форматируем приватный ключ по стандарту AIP-80
    const formattedKey = PrivateKey.formatPrivateKey(fromPrivateKey, 'ed25519' as any);
    
    // Создаем приватный ключ
    const privateKey = new Ed25519PrivateKey(formattedKey);
    
    // Генерируем аккаунт отправителя
    const fromAccount = await Account.fromPrivateKey({ privateKey });
    
    // Конвертируем весь баланс в octas для симуляции
    const balanceInOctas = BigInt(Math.floor(balance * 100000000));
    
    // Симулируем транзакцию для получения параметров газа
    const { gasUsed, gasUnitPrice, maxGasAmount } = await simulateTransaction(
      fromAccount,
      toAddress,
      balanceInOctas
    );
    
    // Рассчитываем верхнюю границу комиссии
    const maxFeeInOctas = BigInt(maxGasAmount * gasUnitPrice);
    const maxFeeInApt = Number(maxFeeInOctas) / 100000000;
    
    // Вычисляем сумму для перевода с учетом верхней границы комиссии
    const transferAmountInOctas = balanceInOctas - maxFeeInOctas; // Убираем дополнительный буфер
    
    // Если после вычета комиссии остается очень маленькая сумма, не отправляем
    if (transferAmountInOctas < BigInt(1000)) { // Меньше 0.00001 APT
      return {
        success: false,
        error: 'Сумма для перевода слишком мала после вычета комиссии',
        toAddress
      };
    }
     
     // Проверяем, что сумма для перевода положительная
     if (transferAmountInOctas <= 0) {
       return {
         success: false,
         error: 'Недостаточно средств для перевода после вычета комиссии',
         toAddress
       };
     }
     
     const transferAmount = Number(transferAmountInOctas) / 100000000;
    
         // Создаем транзакцию перевода с параметрами из симуляции
     const transaction = await aptos.transferCoinTransaction({
       sender: fromAccount.accountAddress,
       recipient: toAddress,
       amount: transferAmountInOctas,
       options: {
         maxGasAmount: maxGasAmount,
         gasUnitPrice: gasUnitPrice,
       }
     });
     
     // Подписываем и отправляем транзакцию
     const pendingTransaction = await aptos.signAndSubmitTransaction({
       signer: fromAccount,
       transaction: transaction,
     });
     
     // Ждем подтверждения транзакции
     const committedTransaction = await aptos.waitForTransaction({
       transactionHash: pendingTransaction.hash,
     });
    
    return {
      success: true,
      hash: pendingTransaction.hash,
      version: committedTransaction.version,
      toAddress
    };
    
     } catch (error) {
     // Проверяем тип ошибки для упрощенного вывода
     const errorMessage = error instanceof Error ? error.message : String(error);
     
     if (errorMessage.includes('INSUFFICIENT_BALANCE_FOR_TRANSACTION_FEE')) {
       return {
         success: false,
         error: 'Недостаточно средств для оплаты комиссии',
         toAddress
       };
     }
     
     return {
       success: false,
       error: errorMessage,
       toAddress
     };
   }
}

/**
 * Отправляет весь баланс с каждого кошелька на соответствующий субаккаунт
 */
export async function transferAllToSubAccounts() {
  try {
    const privateKeys = readPrivateKeys();
    const subAccounts = readSubAccounts();
    
    if (privateKeys.length === 0) {
      console.log(chalk.red("❌ Не найдено приватных ключей"));
      return;
    }
    
    if (subAccounts.length === 0) {
      console.log(chalk.red("❌ Не найдено адресов субаккаунтов в файле sub_accs.txt"));
      return;
    }
    
    if (privateKeys.length !== subAccounts.length) {
      console.log(chalk.red(`❌ Количество ключей (${privateKeys.length}) не совпадает с количеством субаккаунтов (${subAccounts.length})`));
      console.log(chalk.yellow("💡 Убедитесь, что количество строк в keys.txt равно количеству строк в sub_accs.txt"));
      return;
    }
    
    console.log(chalk.cyan.bold(`🚀 Начинаем отправку средств на ${privateKeys.length} субаккаунтов...\n`));
    
    // Получаем цену APT для отображения
    const aptPrice = await getAptPrice();
    console.log(chalk.green.bold(`💰 Цена APT: $${aptPrice.toFixed(4)} USD\n`));
    
    const results: Array<{
      fromAddress: string;
      toAddress: string;
      amount: number;
      success: boolean;
      hash?: string;
      error?: string;
    }> = [];
    
    let totalTransferred = 0;
    let successfulTransfers = 0;
    
    for (let i = 0; i < privateKeys.length; i++) {
      const privateKey = privateKeys[i];
      const subAccountAddress = subAccounts[i];
      
      try {
        console.log(chalk.cyan.bold(`\n📤 Кошелек ${i + 1}/${privateKeys.length}`));
        
        // Генерируем адрес отправителя
        const fromAddress = await generateAddressFromPrivateKey(privateKey);
        console.log(chalk.blue(`От: ${fromAddress.substring(0, 8)}...${fromAddress.substring(fromAddress.length - 8)}`));
        console.log(chalk.blue(`К:  ${subAccountAddress.substring(0, 8)}...${subAccountAddress.substring(subAccountAddress.length - 8)}`));
        
        // Получаем текущий баланс
        const balanceResult = await getAptBalance(fromAddress);
        
        if (balanceResult.balanceApt <= 0) {
          console.log(chalk.gray(`💰 Баланс: ${balanceResult.balanceApt.toFixed(8)} APT - пропускаем`));
          results.push({
            fromAddress,
            toAddress: subAccountAddress,
            amount: 0,
            success: false,
            error: "Нулевой баланс"
          });
          continue;
        }
        
                          console.log(chalk.yellow(`💰 Баланс: ${balanceResult.balanceApt.toFixed(8)} APT`));
         console.log(chalk.yellow(`📤 Отправляем весь баланс (комиссия будет вычтена автоматически)`));
         
         // Отправляем весь баланс
         const transferResult = await transferAllApt(privateKey, subAccountAddress, balanceResult.balanceApt);
         
         // Получаем фактическую сумму перевода из результата
         const actualTransferAmount = transferResult.success ? balanceResult.balanceApt : 0;
         
                    if (transferResult.success) {
             const explorerUrl = `https://explorer.aptoslabs.com/txn/${transferResult.hash}`;
             console.log(chalk.green(`✅ Успешно отправлено!`));
             console.log(chalk.blue(`🔗 Explorer: ${explorerUrl}`));
            totalTransferred += actualTransferAmount;
            successfulTransfers++;
            
            results.push({
              fromAddress,
              toAddress: subAccountAddress,
              amount: actualTransferAmount,
              success: true,
              hash: transferResult.hash
            });
          } else {
            console.log(chalk.red(`❌ Ошибка отправки: ${transferResult.error}`));
            
            results.push({
              fromAddress,
              toAddress: subAccountAddress,
              amount: actualTransferAmount,
              success: false,
              error: transferResult.error
            });
          }
        
                 // Добавляем задержку между транзакциями
         if (i < privateKeys.length - 1) {
           console.log(chalk.gray("⏳ Ожидание 10 секунд перед следующей транзакцией..."));
           await new Promise(resolve => setTimeout(resolve, 10000));
         }
        
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        console.error(chalk.red(`❌ Ошибка при обработке кошелька ${i + 1}:`), errorMessage);
        
        results.push({
          fromAddress: "Ошибка генерации",
          toAddress: subAccounts[i] || "Неизвестно",
          amount: 0,
          success: false,
          error: errorMessage
        });
      }
    }
    
    // Выводим итоговый результат
    const totalUSD = totalTransferred * aptPrice;
    console.log(chalk.cyan.bold(`\n📊 Итоги отправки:`));
    console.log(chalk.green(`✅ Успешных транзакций: ${successfulTransfers}/${privateKeys.length}`));
    console.log(chalk.yellow(`💰 Всего отправлено: ${totalTransferred.toFixed(8)} APT ${chalk.green(`($${totalUSD.toFixed(2)})`)}`));
    
         if (successfulTransfers < privateKeys.length) {
       console.log(chalk.red(`❌ Неудачных транзакций: ${privateKeys.length - successfulTransfers}`));
     }
    
    return { results, totalTransferred, successfulTransfers, totalUSD };
    
  } catch (error) {
    console.error(chalk.red("💥 Критическая ошибка:"), error);
    throw error;
  }
}

/**
 * Показывает предварительную информацию о планируемых переводах
 */
export async function showTransferPreview() {
  try {
    const privateKeys = readPrivateKeys();
    const subAccounts = readSubAccounts();
    
    if (privateKeys.length === 0) {
      console.log(chalk.red("❌ Не найдено приватных ключей"));
      return;
    }
    
    if (subAccounts.length === 0) {
      console.log(chalk.red("❌ Не найдено адресов субаккаунтов в файле sub_accs.txt"));
      return;
    }
    
    if (privateKeys.length !== subAccounts.length) {
      console.log(chalk.red(`❌ Количество ключей (${privateKeys.length}) не совпадает с количеством субаккаунтов (${subAccounts.length})`));
      console.log(chalk.yellow("💡 Убедитесь, что количество строк в keys.txt равно количеству строк в sub_accs.txt"));
      return;
    }
    
    console.log(chalk.cyan.bold(`📋 Предварительный просмотр переводов\n`));
    
    const aptPrice = await getAptPrice();
    console.log(chalk.green.bold(`💰 Цена APT: $${aptPrice.toFixed(4)} USD\n`));
    
    let totalToTransfer = 0;
    
    for (let i = 0; i < privateKeys.length; i++) {
      const privateKey = privateKeys[i];
      const subAccountAddress = subAccounts[i];
      
      try {
        const fromAddress = await generateAddressFromPrivateKey(privateKey);
        const balanceResult = await getAptBalance(fromAddress);
        
                 const transferAmount = balanceResult.balanceApt;
        totalToTransfer += transferAmount;
        
        const addressShort = fromAddress.substring(0, 8) + '...' + fromAddress.substring(fromAddress.length - 8);
        const subAddressShort = subAccountAddress.substring(0, 8) + '...' + subAccountAddress.substring(subAccountAddress.length - 8);
        
        if (transferAmount > 0) {
          const amountUSD = transferAmount * aptPrice;
          console.log(chalk.white(`${i + 1}. ${chalk.blue(addressShort)} → ${chalk.blue(subAddressShort)}`));
          console.log(chalk.yellow(`   💰 ${transferAmount.toFixed(8)} APT ${chalk.green(`($${amountUSD.toFixed(2)})`)}`));
        } else {
          console.log(chalk.gray(`${i + 1}. ${chalk.blue(addressShort)} → ${chalk.blue(subAddressShort)}`));
          console.log(chalk.gray(`   💰 ${transferAmount.toFixed(8)} APT (недостаточно средств)`));
        }
        
        // Добавляем небольшую задержку между запросами
        if (i < privateKeys.length - 1) {
          await new Promise(resolve => setTimeout(resolve, 1000));
        }
        
      } catch (error) {
        console.log(chalk.red(`${i + 1}. ❌ Ошибка при проверке кошелька ${i + 1}`));
      }
    }
    
    const totalUSD = totalToTransfer * aptPrice;
    console.log(chalk.cyan.bold(`\n📊 Всего к отправке: ${chalk.yellow(totalToTransfer.toFixed(8))} APT ${chalk.green(`($${totalUSD.toFixed(2)})`)}`));
    
    return { totalToTransfer, totalUSD };
    
  } catch (error) {
    console.error(chalk.red("💥 Критическая ошибка:"), error);
    throw error;
  }
}
