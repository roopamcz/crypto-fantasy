import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ABI, AggregatorV3InterfaceABI } from './blockchain.abi';
import { CronJob } from 'cron';
import { TokensData } from './tokens-list.data';
import { InjectRepository } from '@nestjs/typeorm';
import { Pool } from './entities/pool.entity';
import { Repository } from 'typeorm';
import { EnteredPool } from './entities/entered-pool.entity';
import { TokenPrice } from './entities/token-price.type';
import { ConfigService } from '@nestjs/config';
import { Winner } from './entities/winners.type';
const Web3 = require('web3');

@Injectable()
export class BlockchainService {
  private web3;
  private subscription;
  private CONTRACT_ADDRESS;
  private myContract;
  constructor(
    @InjectRepository(Pool) private poolRepository: Repository<Pool>,
    @InjectRepository(EnteredPool)
    private enteredPoolRepository: Repository<EnteredPool>,
    private configService: ConfigService,
  ) {
    this.web3 = new Web3(this.configService.get('WEB3_WSS_PROVIDER'));
    this.CONTRACT_ADDRESS = this.configService.get('CONTRACT_ADDRESS');
    this.myContract = new this.web3.eth.Contract(ABI, this.CONTRACT_ADDRESS);
    const options = {
      filter: {
        value: [],
      },
      fromBlock: 'latest',
    };

    //PoolCreated Event
    this.myContract.events
      .poolCreated(options)
      .on('data', async (event) => {
        console.log(event.returnValues);
        //save the event to db
        const {
          poolID,
          tierCount,
          entryFees,
          startTime,
          endTime,
          tokenAddress,
        } = event.returnValues;

        const pool = this.poolRepository.create({
          poolID: parseInt(poolID),
          tierCount: parseInt(tierCount),
          entryFees,
          startTime,
          endTime,
          tokenAddress,
          openPrice: [],
          closePrice: [],
          winners: [],
        });

        await this.poolRepository.save(pool);

        //start time
        const start = this.cronDateFormatter(
          new Date(parseInt(event.returnValues.startTime) * 1000),
        );
        //end time
        const end = this.cronDateFormatter(
          new Date(parseInt(event.returnValues.endTime) * 1000),
        );

        const startJob = new CronJob(
          start,
          () => {
            this.startCallback(startJob, pool);
          },
          null,
          true,
          'Asia/Kolkata',
        );

        const endJob = new CronJob(
          end,
          async () => {
            await this.endCallback(endJob, pool);
            await this.computeWinners(pool.poolID);
          },
          null,
          true,
          'Asia/Kolkata',
        );

        startJob.start();
        endJob.start();
      })
      .on('changed', (changed) => console.log('changed', changed))
      .on('error', (err) => {
        throw err;
      });

    //Entered Pool
    this.myContract.events
      .enteredPool(options)
      .on('data', async (event) => {
        const { user, aggregatorAddress, poolID, tier } = event.returnValues;
        const addr = aggregatorAddress.map((addr) => addr.toLowerCase());
        const enteredPool = this.enteredPoolRepository.create({
          user,
          aggregatorAddress: addr,
          poolID,
          tier,
        });

        await this.enteredPoolRepository.save(enteredPool);
      })
      .on('changed', (changed) => console.log('changed', changed))
      .on('error', (err) => {
        throw err;
      });

    //rewardsDistributed
    // this.myContract.events
    //   .rewardsDistributed(options)
    //   .on('data', (event) => console.log(event))
    //   .on('changed', (changed) => console.log(changed))
    //   .on('error', (err) => {
    //     throw err;
    //   });
  }

  cronDateFormatter(date: Date) {
    const seconds = date.getSeconds();
    const minutes = date.getMinutes();
    const hour = date.getHours();
    const day = date.getDate();
    const month = date.getMonth();
    const temp =
      seconds +
      ' ' +
      minutes +
      ' ' +
      hour +
      ' ' +
      day +
      ' ' +
      month +
      ' ' +
      '*';
    return temp;
  }

  async startCallback(startJob, pool) {
    const openPrice = await this.getCurrentTokenPrices();
    this.poolRepository.update({ poolID: pool.poolID }, { openPrice });
    startJob.stop();
  }

  async endCallback(endJob, pool) {
    const closePrice = await this.getCurrentTokenPrices();
    this.poolRepository.update({ poolID: pool.poolID }, { closePrice });
    endJob.stop();
  }

  async getCurrentTokenPrices() {
    const web3 = new Web3(this.configService.get('WEB3_HTTP_PROVIDER'));
    const prices: TokenPrice[] = [];
    for (let i = 0; i < TokensData.Aggregator.length; i++) {
      const priceFeed = new web3.eth.Contract(
        AggregatorV3InterfaceABI,
        TokensData.Aggregator[i]['address'],
      );

      await priceFeed.methods
        .latestRoundData()
        .call()
        .then(async (priceData) => {
          prices.push({
            address: TokensData.Aggregator[i].address.toLowerCase(),
            price: priceData[1],
            decimals: await priceFeed.methods.decimals().call(),
          });
        });
    }

    return prices;
  }

  async computeWinners(poolID) {
    //get the pool
    const pool = await this.poolRepository.findOne({ poolID });

    //format poolOpenPrice and poolClosePrice
    const openPrice = {};
    pool.openPrice.forEach((item) => {
      openPrice[item.address.toLowerCase()] = item.price;
    });
    const closePrice = {};
    pool.closePrice.forEach((item) => {
      closePrice[item.address.toLowerCase()] = item.price;
    });

    //get all the participants of the pool
    const all = await this.enteredPoolRepository.find({ poolID });
    if (all.length === 0) return;
    //claculate the score/points of the participants
    const participants = all.map((participant) => {
      return {
        user: participant.user,
        score: this.calculateScore(
          participant.aggregatorAddress,
          openPrice,
          closePrice,
        ),
      };
    });
    //sort them in descending order of their score
    participants.sort((a, b) => b.score - a.score);

    //distribute price among the top players and return the winners
    const winners = this.distributePrice(
      participants,
      participants.length * pool.entryFees[0],
    );
    // save them to DB
    await this.poolRepository.update({ poolID }, { winners });
  }

  calculateScore(addresses, poolOpenPrice, poolClosePrice) {
    let score = 0;
    for (let i = 0; i < 10; ++i) {
      const a = BigInt(poolOpenPrice[addresses[i]]);
      const b = BigInt(poolClosePrice[addresses[i]]);
      const c = BigInt(1000000);
      score += Number(((b - a) * c) / a);
    }
    return score;
  }

  distributePrice(participants, totalPoolAmount) {
    if (participants.length === 0) return [];
    const priceShare = [
      [70, 30],
      [50, 30, 20],
      [40, 24, 16, 12, 8],
      [30, 20, 12, 10, 8, 6, 5, 4, 3, 2],
      [30, 20, 10, 7.5, 6, 5, 4, 3, 2.5, 2, 1],
      [28, 18, 10, 7.5, 6, 5, 4, 3, 2, 1.5, 1, 0.5],
      [25, 15, 9, 7.5, 6, 5, 4, 3, 2, 1.5, 1, 0.7, 0.5],
      [25, 15, 8, 6, 5, 4, 3, 2.5, 2, 1.5, 1, 0.7, 0.6, 0.5],
      [23, 14, 7, 6, 5, 4, 3, 2.5, 2, 1.5, 1, 0.7, 0.6, 0.5, 0.4],
      [22, 12, 7, 6, 5, 4, 3, 2.5, 2, 1.5, 1, 0.7, 0.6, 0.5, 0.4, 0.3],
    ];

    const distribute = (prices) => {
      const winners = [];
      for (let i = 0; i < prices.length && i < 10; ++i) {
        winners.push({
          ...participants[i],
          amount: (totalPoolAmount * prices[i]) / 100,
        });
      }
      let j = 10;
      for (let i = 10; i < prices.length; ++i) {
        for (let k = 0; k < 10; ++k) {
          winners.push({
            ...participants[j],
            amount: (totalPoolAmount * prices[i]) / 100,
          });
          ++j;
        }
      }

      return winners;
    };
    if (participants.length > 800) {
      return distribute(priceShare[9]);
    } else if (participants.length > 600) {
      return distribute(priceShare[8]);
    } else if (participants.length > 400) {
      return distribute(priceShare[7]);
    } else if (participants.length > 300) {
      return distribute(priceShare[6]);
    } else if (participants.length > 200) {
      return distribute(priceShare[5]);
    } else if (participants.length > 100) {
      return distribute(priceShare[4]);
    } else if (participants.length > 50) {
      return distribute(priceShare[3]);
    } else if (participants.length > 30) {
      return distribute(priceShare[2]);
    } else if (participants.length >= 3) {
      return distribute(priceShare[1]);
    } else if (participants.length == 1) {
      return [
        {
          user: participants[0].user,
          amount: totalPoolAmount,
        },
      ];
    }

    return distribute(priceShare[0]);
  }

  async transactBalance(poolID: number, winnerList: Winner[]) {
    const web3 = new Web3(this.configService.get('WEB3_HTTP_PROVIDER'));
    const account = '0x9FE35Ded40255Db7043500507a625DC346658Efa'; //Your account address
    const privateKey = this.configService.get('ETH_PRIVATE_KEY');
    const contractAddress = this.configService.get('CONTRACT_ADDRESS'); // Deployed manually
    const contract = new web3.eth.Contract(ABI, contractAddress, {
      from: account,
      gasLimit: 3000000,
    });
    const winner = winnerList.map((item) => item.user);
    const amount = winnerList.map((item) => item.amount);

    //new script
    const { address } = web3.eth.accounts.wallet.add(privateKey);

    const tx = await contract.methods
      .distributeReward(poolID, winner, amount)
      .send({
        from: address,
      });
  }
}
