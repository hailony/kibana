/*
 * Licensed to Elasticsearch B.V. under one or more contributor
 * license agreements. See the NOTICE file distributed with
 * this work for additional information regarding copyright
 * ownership. Elasticsearch B.V. licenses this file to you under
 * the Apache License, Version 2.0 (the "License"); you may
 * not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *    http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing,
 * software distributed under the License is distributed on an
 * "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY
 * KIND, either express or implied.  See the License for the
 * specific language governing permissions and limitations
 * under the License.
 */

import { Plugin, CoreSetup, CoreStart } from 'src/core/public';
import { BehaviorSubject } from 'rxjs';
import { ISearchSetup, ISearchStart, SearchEnhancements } from './types';

import { createSearchSource, SearchSource, SearchSourceDependencies } from './search_source';
import { AggsService, AggsStartDependencies } from './aggs';
import { IndexPatternsContract } from '../index_patterns/index_patterns';
import { ISearchInterceptor, SearchInterceptor } from './search_interceptor';
import { ISearchGeneric } from './types';
import { SearchUsageCollector, createUsageCollector } from './collectors';
import { UsageCollectionSetup } from '../../../usage_collection/public';
import { esdsl, esRawResponse } from './expressions';
import { ExpressionsSetup } from '../../../expressions/public';

/** @internal */
export interface SearchServiceSetupDependencies {
  expressions: ExpressionsSetup;
  usageCollection?: UsageCollectionSetup;
}

/** @internal */
export interface SearchServiceStartDependencies {
  fieldFormats: AggsStartDependencies['fieldFormats'];
  indexPatterns: IndexPatternsContract;
}

export class SearchService implements Plugin<ISearchSetup, ISearchStart> {
  private readonly aggsService = new AggsService();
  private searchInterceptor!: ISearchInterceptor;
  private usageCollector?: SearchUsageCollector;

  public setup(
    { http, getStartServices, injectedMetadata, notifications, uiSettings }: CoreSetup,
    { expressions, usageCollection }: SearchServiceSetupDependencies
  ): ISearchSetup {
    this.usageCollector = createUsageCollector(getStartServices, usageCollection);

    /**
     * A global object that intercepts all searches and provides convenience methods for cancelling
     * all pending search requests, as well as getting the number of pending search requests.
     */
    this.searchInterceptor = new SearchInterceptor({
      toasts: notifications.toasts,
      http,
      uiSettings,
      startServices: getStartServices(),
      usageCollector: this.usageCollector!,
    });

    expressions.registerFunction(esdsl);
    expressions.registerType(esRawResponse);

    return {
      aggs: this.aggsService.setup({
        registerFunction: expressions.registerFunction,
        uiSettings,
      }),
      usageCollector: this.usageCollector!,
      __enhance: (enhancements: SearchEnhancements) => {
        this.searchInterceptor = enhancements.searchInterceptor;
      },
    };
  }

  public start(
    { application, http, injectedMetadata, notifications, uiSettings }: CoreStart,
    { fieldFormats, indexPatterns }: SearchServiceStartDependencies
  ): ISearchStart {
    const search = ((request, options) => {
      return this.searchInterceptor.search(request, options);
    }) as ISearchGeneric;

    const loadingCount$ = new BehaviorSubject(0);
    http.addLoadingCountSource(loadingCount$);

    const searchSourceDependencies: SearchSourceDependencies = {
      getConfig: uiSettings.get.bind(uiSettings),
      search,
      http,
      loadingCount$,
    };

    return {
      aggs: this.aggsService.start({ fieldFormats, uiSettings }),
      search,
      searchSource: {
        /**
         * creates searchsource based on serialized search source fields
         */
        create: createSearchSource(indexPatterns, searchSourceDependencies),
        /**
         * creates an enpty search source
         */
        createEmpty: () => {
          return new SearchSource({}, searchSourceDependencies);
        },
      },
    };
  }

  public stop() {
    this.aggsService.stop();
  }
}
