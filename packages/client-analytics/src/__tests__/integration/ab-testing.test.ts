import { createRetryablePromise } from '@algolia/client-common';
import { Transporter } from '@algolia/transporter';

import { ABTest, Variant } from '../..';
import { createFaker } from '../../../../client-common/src/__tests__/createFaker';
import { createMultiWaitable } from '../../../../client-common/src/__tests__/helpers';
import { TestSuite } from '../../../../client-common/src/__tests__/TestSuite';

const testSuite = new TestSuite('ab_testing');

afterAll(() => testSuite.cleanUp());

const createRetryableTransporter = (client: Transporter): Transporter => {
  return new Proxy(client, {
    get(obj: any, method: string) {
      return (...args: any) => {
        return createRetryablePromise(retry => {
          return obj[method](...args).catch((err: Error) => {
            if (err.message === 'Too Many Requests') {
              return retry();
            }

            throw err;
          });
        });
      };
    },
  });
};

test(testSuite.testName, async () => {
  const index1 = testSuite.makeIndex();
  const index2 = testSuite.makeIndex();
  const client = testSuite.makeSearchClient();
  const analytics = client.initAnalytics();

  // @ts-ignore
  analytics.transporter = createRetryableTransporter(analytics.transporter);
  const today = new Date();
  const todayDate = `${today.getFullYear}-${today.getMonth}-${today.getDay}`;

  // Delete old AB tests
  {
    const getABTestsResponse = await analytics.getABTests();

    if (getABTestsResponse.count) {
      const oldABTests = getABTestsResponse.abtests;

      await Promise.all(
        oldABTests
          .filter(
            abtest => abtest.name.startsWith('js-') && !abtest.name.startsWith(`js-${todayDate}`)
          )
          .map(abtest => analytics.deleteABTest(abtest.abTestID))
      );
    }
  }
  // Create the two indices by adding a dummy object in each of them
  const object = createFaker().object('one');
  await createMultiWaitable([index1.saveObject(object), index2.saveObject(object)] as any).wait();

  const abTestName = testSuite.makeIndexName();
  const abTest: ABTest = {
    name: abTestName,
    variants: [
      {
        index: index1.indexName,
        trafficPercentage: 60,
        description: 'a description',
      },
      { index: index2.indexName, trafficPercentage: 40 },
    ],
    endAt: new Date(today.getTime() + 24 * 3600 * 1000).toISOString(),
  };

  const addABTestResponse = await analytics.addABTest(abTest);
  const abTestID = addABTestResponse.abTestID;
  await client.initIndex(addABTestResponse.index).waitTask(addABTestResponse.taskID);

  const compareVariants = (got: readonly Variant[], expected: readonly Variant[]) => {
    const convertedVariants = got.map(v => {
      const hasDescription = v.description && v.description.length !== 0;

      return {
        index: v.index,
        trafficPercentage: v.trafficPercentage,
        ...(hasDescription ? { description: v.description } : {}),
      };
    });

    expect(convertedVariants).toEqual(
      // @ts-ignore
      expect.arrayContaining<Variant>(expected)
    );
    expect(expected).toEqual(expect.arrayContaining(convertedVariants));
  };

  const compareDateStrings = (got: string, expected: string) => {
    expect(new Date(got).getTime()).toBe(new Date(expected).getTime());
  };

  // Retrieve the AB test and check it corresponds to the original one
  {
    const found = await analytics.getABTest(abTestID);
    expect(found.abTestID).toBe(abTestID);
    expect(found.name).toBe(abTest.name);
    compareDateStrings(found.endAt, abTest.endAt);
    compareVariants(found.variants, abTest.variants);
  }

  // Find the AB test among all the existing AB tests and check it
  // corresponds to the original one
  {
    const all = await analytics.getABTests();
    const found = all.abtests.find(t => t.abTestID === abTestID);
    if (found === undefined) {
      throw new Error('Ab test not found.');
    }

    expect(found.abTestID).toBe(abTestID);
    expect(found.name).toBe(abTest.name);
    compareDateStrings(found.endAt, abTest.endAt);
    compareVariants(found.variants, abTest.variants);
  }

  // Stop the AB test
  const stopABTestResponse = await analytics.stopABTest(abTestID);
  await index1.waitTask(stopABTestResponse.taskID);

  // Check the AB test still exists but is stopped
  await expect(analytics.getABTest(abTestID)).resolves.toMatchObject({
    status: 'stopped',
  });

  // Delete the AB test
  const deleteABTestResponse = await analytics.deleteABTest(abTestID);
  await index1.waitTask(deleteABTestResponse.taskID);

  // Check the AB test doesn't exist anymore
  await expect(analytics.getABTest(abTestID)).rejects.toMatchObject({
    name: 'ApiError',
    message: 'ABTestID not found',
    status: 404,
  });
});
